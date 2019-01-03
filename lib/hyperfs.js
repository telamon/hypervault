const kappaKV = require('kappa-view-kv')
const memdb = require('memdb')
const path = require('path')
const collect = require('collect-stream')
const debug = require('debug')('hyperfs')


const DEFAULT_FEED = 'local'

class HyperFS {
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
    const value = JSON.parse(msg.value.toString('utf8'))
    const op = {
      id: value.id,
      key: value.path,
      links: value.links || []
    }
    next(null, [op])
  }

  set (name, value, callback) {
    debug('SET OP:', name, value)
    const fpath = path.resolve('/', name)

    this.kv.ready(() => {
      debug('SET OP: ready', name)
      this.kv.get(fpath, (err, parents) => {
        if(err && err.type !== 'NotFoundError') return callback(err)
        if (!parents) debug('SET OP: creating new entry', name)

        this.db.feed(DEFAULT_FEED, (err, writer) => {
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
            entry.links = parents.map(e => JSON.parse(e.value.toString('utf8')).id)
          }
          debug('SET OP: appending changes', name)
          writer.append(Buffer.from(JSON.stringify(entry)), callback)
        })
      })
    })

    // not used
    const self = this
    function verify(err) {
      if (err) return callback(err)
      self.kv.get(fpath, (err, data) => {
        callback(err, data)
      })
    }
  }

  get (name, callback) {
    debug('GET OP:', name)
    this.kv.ready(() => {
      this.kv.get(path.resolve('/', name), (err, values) => {
        if (err) return callback(err)
        if (values) {
          const mappedValues = values.map(encoded => JSON.parse(encoded.value.toString('utf8')))
          callback(null, pickOne(mappedValues))
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
          const value = JSON.parse(pair.value.value.toString('utf8'))
          debug(pair.key, value.stat.mtime)

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
}

function pickOne(...entries) {
  if (Array.isArray(entries[0])) entries = entries[0]
  // when conflicts arise pick file with highest stat.mtime
  return entries.sort((a, b) => b.stat.mtime - a.stat.mtime)[0]
}
// TODO: making this a method until the kappa-view-kv bug is fixed
function extractKeyFromID (id) {
  return id.split('@')[0]
}

module.exports = HyperFS
module.exports.DEFAULT_FEED = DEFAULT_FEED
