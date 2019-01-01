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

  // wow such a mess, this needs to be routed to our global writer's doc.
  // this gets called by hyperdrive since hyperdrive thinks that this object
  // is it's append-tree; So we're already telling the correct hyperdrive to
  // give us the file, but now it's asking us for the block-positions
  get (key, ...opts) {
    this.core.wormholeGet(key, ...opts)
  }
}

class Hyperphet extends hypercore {
  constructor (storage, key, opts) {
    super(storage, key, opts)
    this.doc = null // Managed on a higher level
    this.tree = new CompatibleTree(this)
    this.ready(() => {
      if (this.writable) {
        this.doc = am.init(this.discoveryKey.toString('hex'))
        // Load local core changes
        this.loadChanges((err, changes) => {
          if (err) throw err
          changes.forEach(batch => {
            this.doc = am.applyChanges(this.doc, batch)
          })
        })
      }
    })
  }
  ready (callback) {
    super.ready(callback)
  }
  append (...args) {
    super.append(...args)
    debug('Append: ', args[0].toString('utf8'))
  }

  loadChanges (callback) {
    // v0 includes hyperdrive header which is of no use to us
    const stream = this.createReadStream({version: 1})
    stream.on('data', (buf) => {
      if (buf.toString('utf8').match(/^\n\nhyperdrive/)) return
    })
    stream.once('error', callback)
    stream.once('end', (err) => {
      callback(err, [])
    })
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
