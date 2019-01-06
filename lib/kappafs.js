const kappaKV = require('kappa-view-kv')
const memdb = require('memdb')
const path = require('path')
const collect = require('collect-stream')
const duplexify = require('duplexify')
const from2 = require('from2')
const debug = require('debug')('kappafs')
const fs = require('fs')
const pump = require('pump')
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
    this.kv.onUpdate((key, value) => {
      this.emit('update', key, value)
      this.writableDrive((err, drive) => {
        if (!err && drive.key.toString('hex') !== value.key) {
          return this.emit('remote-update', key, value)
        }
      })
    })
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
    const fpath = path.resolve('/', name)

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

    // not used
    const self = this
    function verify(err) {
      if (err) return callback(err)
      self.kv.get(fpath, (err, data) => {
        debugger
        callback(err, data)
      })
    }
  }

  get (name, callback) {
    // debug('GET OP:', name)

    const normalize = (o) => {
      o.mtime = new Date(o.mtime)
      o.ctime = new Date(o.ctime)
      return o
    }

    this.kv.ready(() => {
      this.kv.get(path.resolve('/', name), (err, entries) => {
        if (err) return callback(err)
        if (entries) {
          const values = entries.map(entry => normalize(entry.value))

          callback(null, pickOne(values))
        } else callback(null)
      })
    })
  }

  toHash (callback) {
    this.kv.ready(() => {
      collect(this.kv.createReadStream(), (err, data) => {
        if (err) return callback(err)
        debug('Dumping index')
        callback(null, data.reduce((tree, pair) => {
          const value = pair.value.value
          debug(pair.key, value.mtime)

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
      const tombstone = Object.assign(prev,{deleted: true, deletedAt: new Date().getTime()})
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
              mtime: getTime(opts.mtime),
              ctime: getTime(opts.ctime),
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
          if (idx !== blockId) debugger // this means that get() also streams in chunks.
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
          if (haveBlocks) onBlocksAvailable() // blocks are available

          else if (binfeed.peers.length) { // blocks not available but we're connected to a peer
            debug(`Downloading blocks ${start}..${end}`)
            binfeed.download({start, end}, onBlocksAvailable)

          } else if (!opts.wait){ // blocks not available and application is not prepared to wait
            const err = new Error('Blocks missing and no active peers to download from, please swarm!')
            err.type = 'BLOCKS_MISSING'
            err.range = {start, end}
            err.feed = binfeed.key
            callback(err)

          } else { // blocks not available but we're prepared to wait for them.
            onBlocksAvailable()
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

            fs.open(destination, 'w', entry.mode, (err, fd) => {
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
  if (!date) return Date.now()
  return date.getTime()
}

module.exports = KappaFilesystem
module.exports.DEFAULT_FEED = DEFAULT_FEED

