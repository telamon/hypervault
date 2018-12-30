/*
* Hyperprophet - spaws prophecies that always come true.
*/

const hypercore = require('hypercore')
const am = require('automerge')
const debug = require('debug')('hypervault/prophecy')
const path = require('path')
/* An injected object that mimics behaviour of mafintosh/append-tree
 */
class CompatibleTree {
  constructor (core) {
    this.core = core
  }
  ready (...args) {
    this.core.ready(...args)
  }

  put (key, value, callback) {
    const newState = am.change(this.core.doc, d => {
      // Todo: feed key is not really needed.
      d[path.resolve('/', key)] = Object.assign(value, {feed: this.core.discoveryKey.toString('hex')})
    })
    const changes = am.getChanges(this.core.doc, newState)
    this.core.append(Buffer.from(JSON.stringify(changes)), err => {
      if (err) return callback(err)
      this.core.doc = newState
      callback(null)
    })
  }

  del (key, callback) {
    const newState = am.change(this.core.doc, d => {
      delete d[path.resolve('/', key)]
    })
    const changes = am.getChanges(this.core.doc, newState)
    this.core.append(Buffer.from(JSON.stringify(changes)), err => {
      if (err) return callback(err)
      this.core.doc = newState
      callback(null)
    })
  }

  get (key, callback) {
    callback(null, this.core.doc[path.resolve('/', key)])
  }
}

class Hyperphet extends hypercore {
  constructor (storage, key, opts) {
    super(storage, key, opts)
    this.doc = null
    this.tree = new CompatibleTree(this)
    this.on('download', this.remoteChangeDownloaded.bind(this))
  }
  ready (callback) {
    super.ready(() => {
      if (!this.doc) this.loadChanges(callback)
      else callback()
    })
  }
  append (...args) {
    super.append(...args)
    debug('Append: ', args[0].toString('utf8'))
  }

  loadChanges (callback) {
    // v0 includes hyperdrive header which is of no use to us
    const stream = this.createReadStream({version: 1})
    this.doc = am.init(this.discoveryKey.toString('hex'))
    stream.on('data', (buf) => {
      debugger
    })
    stream.once('error', callback)
    stream.once('end', callback)
  }

  remoteChangeDownloaded (seq, data, peer) {
    if (data.toString('utf8').match(/^\n\nhyperdrive/)) return
    try {
      const patch = JSON.parse(data.toString('utf8'))
      this.doc = am.applyChanges(this.doc, patch)
    } catch(err) {
      debug("Tree corrupted, eject, eject, eject!", err)
      this.emit('error', err)
      this.removeAllListeners()
    }
  }
}


/*
  const db = opts.checkout || hyperdb(storage, key, {
    valueEncoding: messages.Stat,
    contentFeed: this.contentStorage,
    secretKey: opts.secretKey,
    sparse: opts.sparse,
    sparseContent: opts.sparse || opts.latest || opts.sparseContent,
    reduce, // TODO: make configurable
    onwrite: opts.latest && onwrite
  })
 */
module.exports = Hyperphet
