const kappaKV = require('kappa-view-kv')
const memdb = require('memdb')
const path = require('path')
const collect = require('collect-stream')
const duplexify = require('duplexify')
const debug = require('debug')('hyperfs')


const DEFAULT_FMODE = (4 | 2 | 0) << 6 | ((4 | 0 | 0) << 3) | (4 | 0 | 0) // rw-r--r--
const DEFAULT_FEED = 'local'

class KappaFilesystem {
  constructor (kappa) {
    // Initialize kappa-core with our own multifeed
    this.db = kappa
    const idx = memdb({valueEncoding: 'json'})
    this.db.use('files', kappaKV(idx, this._map.bind(this)))
    this.kv = this.db.api.files
    this.kv.onUpdate((key) => {
      debug('indexUpdated', key)
    })
    debug('initialized')
  }

  _map (msg, next) {
    debug('mapFN:', msg.seq)
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
    debug('SET OP:', name, value)
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
    debug('GET OP:', name)
    this.kv.ready(() => {
      this.kv.get(path.resolve('/', name), (err, entries) => {
        if (err) return callback(err)
        if (entries) {
          const values = entries.map(entry => entry.value)
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

    const stream = this.createWriteStream(name, opts, (err, stream) => {
      stream.end(Buffer.from(data), (err) => {
        callback(err)
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

    // TODO: atomic write meta+binfeed
    const persistMeta = (done) => {
    }

    this.writableDrive((err, drive) => {
      if (err) return callback(err)

      drive.binfeed((err, feed) => {
        if (err) return callback(err)
        drive.writeLock((releaseLock) => {
          // make a note of our current feed length and bytesize
          const bytesBeforeAction = feed.byteLength
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
              if (err) debugger // Tricky, got alot more to cleanup if meta fails to write.
              proxy.uncork()
              debug('Meta persisted')
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

