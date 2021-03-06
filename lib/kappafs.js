const kappaKV = require('kappa-view-kv')
const memdb = require('memdb')
const path = require('path')
const collect = require('collect-stream')
const duplexify = require('duplexify')
const from2 = require('from2')
const debug = require('debug')('kappafs')
const fs = require('fs')
const pump = require('pump')
const unixify = require('unixify')
const {EventEmitter} = require('events')


const DEFAULT_FMODE = 0o644 // rw-r--r--
const DEFAULT_FEED = 'local'

class KappaFilesystem extends EventEmitter {

  constructor (kappa) {
    super()
    // Initialize kappa-core with our own multifeed
    this.db = kappa
    const idx = memdb({valueEncoding: 'json'})
    this.db.use('files', kappaKV(idx, this._map.bind(this)))
    this.kv = this.db.api.files

    const onupdate = (key, value) => {
      this.emit('update', key, value)
      this.writableDrive((err, drive) => {
        if (!err && drive.key.toString('hex') !== value.key) {
          return this.emit('remote-update', key, value)
        } else {
          return this.emit('local-update', key, value)
        }
      })
    }
    this.kv.onUpdate(onupdate)

    debug('initialized')
  }

  _map (msg, next) {
    if (msg.value.core === 'METADRIVE') return next() // Ignore header
    const value = msg.value
    const op = {
      id: value.id,
      key: value.path,
      links: value.links || []
    }
    next(null, [op])
  }

  writableDrive (callback) {
    this.db.feed(DEFAULT_FEED, callback)
  }

  set (name, value, callback) {
    const fpath = virtualize(name)

    this.kv.ready(() => {
      debug('SET OP: ready', name)
      this.kv.get(fpath, (err, parents) => {
        if(err && err.type !== 'NotFoundError') return callback(err)
        if (!parents) debug('SET OP: creating new entry', name)

        this.writableDrive((err, writer) => {
          // kappa-view-kv can't handle discoveryKeys, needs to be improved.
          // there's a todo therein as describing the issue
          const id = [writer.key.toString('hex'), writer.length].join('@')
          const entry = Object.assign(value, {
            id,
            links: [],
            path: fpath,
          })
          // append links of previous known records
          if (Array.isArray(parents)) {
            entry.links = parents.map(e => e.value.id)
          }
          debug('SET OP: appending changes', name)
          writer.append(entry, callback)
        })
      })
    })
  }

  get (name, callback) {
    // debug('GET OP:', name)
    this.kv.ready(() => {
      this.kv.get(virtualize(name), (err, entries) => {
        if (err) return callback(err)
        if (entries) {
          const values = entries.map(entry => normalizeEntry(entry.value))

          callback(null, pickOne(values))
        } else callback(null)
      })
    })
  }

  toHash (callback) {
    this.kv.ready(() => {
      collect(this.kv.createReadStream(), (err, data) => {
        if (err) return callback(err)

        callback(null, data.reduce((tree, pair) => {
          const value = normalizeEntry(pair.value.value)

          if (typeof tree[pair.key] === 'undefined') tree[pair.key] = value
          else tree[pair.key] = pickOne(tree[pair.key], value)

          return tree
        }, {}))
      })
    })
  }

  unlink (...args) { return this.bury(...args) }
  bury (name, callback) {
    this.get(name, (err, prev) => {
      if (err) return callback(err)
      const tombstone = Object.assign(prev,{
        deleted: true,
        mtime: Date.now()
      })
      this.set(name, tombstone, callback)
    })
  }

  feedOf (name, callback) {
    this.get(name, (err, entry) => {
      if (err) return callback(err)
      if (!entry) return callback(null)
      const feed = this.db._logs.feeds().find(f => f.key.toString('hex') === extractKeyFromID(entry.id))
      callback(null, feed)
    })
  }

  writeFile(name, data, opts, callback) {
    if(typeof opts === 'function') { callback = opts; opts = undefined}
    if (!opts) opts = {}

    this.createWriteStream(name, opts, (err, stream) => {
      stream.end(Buffer.from(data), (err) => {
        process.nextTick(() => callback(err))
      })
    })
  }

  createWriteStream(name, opts, callback) {
    if(typeof opts === 'function') { callback = opts; opts = {} }
    // Each chunk written to a hypercore write stream causes a new log-entry
    // original hyperdrive uses pre and post append hypercore.byteLength
    // to calculate bytes written, this design limits you to:
    // A) All files must be stored in sequentially (no fragmentation allowed)
    // B) Writer must be mutex-locked as writes in parallell would cause
    // fragmentation
    // C) Whole file must be reinserted on change, storage inefficient but
    // no overhead during read.
    // Due lack of better effort I'm going to reproduce the mutex pattern.

    this.writableDrive((err, drive) => {
      if (err) return callback(err)

      drive.binfeed((err, feed) => {
        if (err) return callback(err)
        drive.writeLock((releaseLock) => {
          // make a note of our current feed length and bytesize
          const bytesBeforeAction = feed.byteLength
          // this one tripped me up; Index of new block is ofcourse going to
          // equal the 'length' of curent blocks since a length of 5 means
          // current last block is on index 4. Thus: length = offset
          const lengthBeforeAction = feed.length

          // initialize our stream interceptor
          const proxy = duplexify()

          const cleanup = () => {
            proxy.removeListener('end', cleanup)
            proxy.removeListener('finish', cleanup)
            proxy.removeListener('error', cleanup)
            releaseLock()
            debug('write stream closed', name)
          }

          // configure the proxy
          proxy.setReadable(false)
          proxy.on('error', cleanup)
          proxy.on('close', cleanup)
          proxy.on('finish', cleanup)

          // persist metadata on prefinish
          proxy.on('prefinish', () => {
            proxy.cork()
            const entry = {
              // filestat
              mode: (opts.mode || DEFAULT_FMODE),
              uid: opts.uid || 0,
              gid: opts.gid || 0,
              mtime: getTime(opts.mtime || Date.now()),
              ctime: getTime(opts.ctime || Date.now()),
              size: feed.byteLength - bytesBeforeAction,
              // binary pointer
              blocks: feed.length - lengthBeforeAction,
              offset: lengthBeforeAction,
              byteOffset: bytesBeforeAction
            }

            this.set(name, entry, (err) => {
              // Tricky, got alot more to cleanup if meta fails to write.
              // not quite sure how to recover from this situation. but i guess
              // better to have a binfeed with duplicate data than a totally
              // corrupt one.
              if (err) {
                proxy.emit('error', err)
                proxy.destroy()
                cleanup()
                throw err
              }
              debug(`successfully stored ${name} @${entry.offset} nblocks: ${entry.blocks} sz: ${entry.size}B}`)
              proxy.uncork() // releases the stream to let the 'end' event be emitted
              cleanup()
            })
          })

          // initialize the real binary-feed stream
          const stream = feed.createWriteStream()
          proxy.setWritable(stream)

          // and expose the proxy-stream to the application
          callback(null, proxy)
          debug('writeStream created', name)
        })
      })
    })
  }

  readFile (name, opts, callback) {
    if(typeof opts === 'function') { callback = opts; opts = {}}
    this.createReadStream(name, opts, (err, stream) => {
      if (err) return callback(err)
      collect(stream, (err, data) => {
        callback(err, data)
      })
    })
  }

  createReadStream (name, opts, callback) {
    if(typeof opts === 'function') { callback = opts; opts = {}}
    let entry = null
    let drive = null
    let binfeed = null

    // Creates a readstream using from2 and sequentially passes
    // as they become available
    const onBlocksAvailable = err => {
      if(err) return callback(err)

      let bytesRead = 0
      // let block = null
      let blockId = entry.offset
      const stream = from2((requestedSize, next) => {
        const bytesLeftToRead = entry.size - bytesRead
        if (bytesLeftToRead < 1) return next(null, null) // End stream

        /* let payload = null // TODO: respect requestedSize
        if (block && blockByteOffset < block.length) { // there's still left data from previous run
          debugger
          payload = block.slice(blockByteOffset, Math.min(block.length, requestedSize))
        }*/

        const getOpts = {wait: !!opts.wait, valueEncoding: 'binary', timeout: opts.timeout || 0}
        const idx = blockId
        binfeed.get(blockId, getOpts, (err, chunk) => {
          if (err) return next(err)
          // if (idx !== blockId) debugger // this means that get() also streams in chunks.
          blockId++
          bytesRead = bytesRead + chunk.length
          next(null, chunk)
        })

      })
      callback(null, stream)
    }

    // Initializes entry, binfeed and drive defined above and tries to ensure
    // data availablilty during live replication
    this.get(name, (err, _entry) => {
      if(err) return callback(err)
      entry = _entry
      this.feedOf(name, (err, _drive) => {
        if (err) return callback(err)
        drive = _drive
        drive.binfeed((err, feed) => {
          binfeed = feed
          const start = entry.offset
          const end = start + entry.blocks

          let haveBlocks = true
          for (let i = start; i < end && haveBlocks; i++) haveBlocks = drive.has(i)
          // TODO: make wait: true be the default behaviour?
          if (haveBlocks || opts.wait) onBlocksAvailable() // blocks are available or we'll wait for them.
          /*
          else if (binfeed.peers.length) { // blocks not available but we're connected to a peer
            debug(`Downloading blocks ${start}..${end} from ${binfeed.key.toString('hex').substring(0,8)}`)
            binfeed.download({start, end}, (err, ...args) => {
              debug(`FINISHED Downloading blocks ${start}..${end} from ${binfeed.key.toString('hex').substring(0,8)}`)
              onBlocksAvailable(err)
            })
          }*/
          else { // blocks not available and application is not prepared to wait
            const err = new Error('Blocks missing and no active peers to download from, please swarm!')
            err.type = 'BLOCKS_MISSING'
            err.range = {start, end}
            err.feed = binfeed.key
            callback(err)
          }
        })
      })
    })
  }

  exportFile (name, destination, opts = {}, callback){
    if (typeof opts === 'function') return this.exportFile(name, destination, undefined, opts)

    this.get(name, (err, entry) => {
      if (err) return callback(err)

      fs.mkdir(path.dirname(destination), {recursive: true}, err => {
        if (err) return callback(err)

        this.createReadStream(name, opts, (err, stream) => {
          if (err) return callback(err)

          const fileStream = fs.createWriteStream(destination, {mode: entry.mode})
          pump(stream, fileStream, (err) => {
            if (err) return callback(err)

            fs.open(destination, 'r', entry.mode, (err, fd) => {
              if (err) return callback(err)

              const nativeTime = entry.mtime / 1000 // TODO: convert to and from UTC?

              fs.futimes(fd, nativeTime, nativeTime, (err) => {
                fs.close(fd, () => callback(err) )
              })
            })
          })
        })
      })
    })
  }

  importFile (name, source, callback) {
    fs.lstat(source, (err, stat) => {
      if (err) return callback(err)
      const fopts = {
        mode: stat.mode, // TODO Only track the execute flag.
        mtime: stat.mtime,
        ctime: stat.ctime
      }

      this.createWriteStream(name, fopts, (err, stream) => {
        if (err) return callback(err)
        const fstream = fs.createReadStream(source)
        pump(fstream, stream, callback)
      })
    })
  }

  readdir (name, callback) {
    const fpath = (virtualize(name) +  '/').replace(/\/\//, '/')
    this.toHash((err, tree) => {
      const regex = new RegExp(`^${fpath}`)
      const folder = Object.keys(tree)
        .filter(file => regex.test(file))
        .reduce((dir, file) => {
          const m = file.match(new RegExp(`^${fpath}([^/]+)(/|$)`))
          if (m) {
            dir[m[1]] = m[2] === '/'
          }
          return dir
        }, {})

      const sorted = Object.keys(folder).sort().sort((a, b) => {
        if (folder[a] && folder[b]) return 0
        else if (folder[a]) return -1
        else if (folder[b]) return 1
        else return 0
      })

      if (sorted.length) callback(null, sorted)
      else callback('ENOENT')
    })
  }

  // does not return fs.Stats objects.
  // leaving this as a separate function in case someone
  // perfers plain hash responses.
  vstat (name, callback) {
    const uid = process.getuid ? process.getuid() : 0
    const gid = process.getgid ? process.getgid() : 0
    const IFREG = 32768

    // const IFDIR = 16384
    this.get(name, (err, stat) => {
      // if file exists then just return the meta obj.
      if (!err) callback(null, Object.assign(stat, {uid, gid, mode: stat.mode | IFREG}))

      else if (err.type === 'NotFoundError') {
        // If error is caused by file not existing,
        // then let's try and see if it maybe is a virtual folder.
        this.readdir(path.dirname(virtualize(name)), (listErr, list) => {
          if (listErr) return callback(listErr)
          const isVirtualDir = list.some(p => p === name)
          if (isVirtualDir) {
            // It's a virtual directory
            const defaultDirStat = {  // hardcoded folderstat dummy.
              mtime: new Date(), // TODO: fix dates somehow?
              atime: new Date(),
              ctime: new Date(),
              nlink: 1,
              size: 100,
              mode: 16877,
              uid,
              gid
            }
            callback(null, defaultDirStat)
          } else {
            callback(err)
          }
        })
      }
      else callback(err)
    })
  }

  // Returns fs.Stats
  lstat(name, callback) {
    this.vstat(name, (err, stat) => {
      if (err) return callback(err)
      callback(null, createStats(stat))
    })
  }
}

// Got the constructor definition using:
// fs.Stats.toString()
function createStats(obj) {
  return new fs.Stats(
    obj.dev,
    obj.mode,
    obj.nlink || 1,
    obj.uid,
    obj.gid,
    obj.rdev,
    obj.blksize || obj.size,
    obj.ino,
    obj.size,
    obj.blocks,
    new Date(obj.atime || obj.mtime).getTime(),
    new Date(obj.mtime).getTime(),
    new Date(obj.ctime || obj.mtime).getTime(),
    new Date(obj.birthtime || obj.mtime).getTime()
  )
}

function virtualize (p) {
  return unixify(path.resolve('/', p))
}

function pickOne(...entries) {
  if (Array.isArray(entries[0])) entries = entries[0]
  // when conflicts arise pick file with highest stat.mtime
  return entries.sort((a, b) => b.mtime - a.mtime)[0]
}

// TODO: making this a method until the kappa-view-kv bug is fixed
function extractKeyFromID (id) {
  return id.split('@')[0]
}

// Borrowed from mafintosh/hyperdrive
function getTime (date) {
  if (typeof date === 'number') return date
  if (typeof date === 'string') return new Date(date).getTime()
  if (date) return date.getTime()
  return date
}

function normalizeEntry (o) {
  o.mtime = new Date(o.mtime)
  o.ctime = new Date(o.ctime)
  return o
}

module.exports = KappaFilesystem
module.exports.DEFAULT_FEED = DEFAULT_FEED

