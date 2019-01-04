/**
 * A datastructure inspired by mafintosh/hyperdrive
 * Exception being that meta-data is first hand owned by external application.
 * metadrive is unable to catalogue it's own content, it only provides a
 * replicatable storage area for binaries and metadata but dosen't actually
 * touch the content. (with the exception of the binRef header)
 *
 * Some things to consider if you want to use metadrive:
 *  * full Node FS api is out of scope and not supported. (meta handling is
 *  in another castle)
 *  * No random data access (cursor/iterator is missing ) (todo?)
 *  * No protobuffers (plain bloaty json and application defined)
 *  * No optimizations nor cache. (todo?)
 *  * No version checkouts (belongs to kappafs)
 *  * No dat-storage support / 'latest' mode
 */

const hyperdrive = require('hyperdrive')
const hypercore = require('hypercore')
const path = require('path')
const mutexify = require('mutexify')
const debug = require('debug')('metadrive')

class MetaDrive extends hypercore {

  constructor (storage, key, opts) {
    // normalize opts
    if (!!key && typeof key !== 'string' && !Buffer.isBuffer(key)) {
      opts = key
      key = null
    }

    opts = opts || {}
    // Subpath metadata-core
    const metaStorage = (name, ...opts) => {
      return storage(path.join('meta',name), ...opts)
    }
    // Call to super constructor
    super(metaStorage, key, Object.assign({}, opts, {
      valueEncoding: 'json'
    }))

    this.opts = opts
    this.storage = storage
    this.writeLock = mutexify()
  }

  replicate (opts) {
    const stream = super.replicate(opts)
    debug('replicating meta', this.key.toString('hex').substr(0,8))
    // Join the binfeed into repl stream once available
    this.binfeed((err, binfeed) => {
      debug('joining binfeed into replication', binfeed.key.toString('hex').substr(0,8))
      if (err) return stream.emit('error', err)
      binfeed.replicate({stream})
    })
    return stream
  }
  /** returns the feed containing big-content
   * ensures that callback receives a usable binary-feed
   */
  binfeed (callback) {
    super.ready(() => {
      if (this._bin) {
        this._bin.ready(()=>{
          callback(null, this._bin)
        })
      }
      else this._initializeContent(callback)
    })
  }

  _initializeContent (callback) {
    const NOP = 1
    const CREATE_WRITABLE_FEED = 2
    const WRITE_HEADER = 3
    const CREATE_READABLE_FEED = 4

    const contentStorage = (name, ...opts) => {
      return this.storage(path.join('content', name), ...opts)
    }

    // Decide what to do
    const chain = p(done => {
      if (this.has(0)) done(null, NOP) // get it
      else if (this.writable) done(null, CREATE_WRITABLE_FEED) // create it first
      else done(null, NOP) // wait for download
    })

    // Create binfeed if needed
      .then(action => {
        if (action !== CREATE_WRITABLE_FEED) return NOP // no need to create nor header
        debug('creating writable binfeed')
        this._bin = hypercore(contentStorage, null, Object.assign({}, this.opts, {valueEncoding: 'binary'}))

        return p(done => this._bin.ready(done)).then(() => WRITE_HEADER)
      })

    //Create the binref header in meta-feed containing the binfeed pubkey
      .then(action => {
        if (action !== WRITE_HEADER) return true // no need to create
        debug('Appending binref header to meta')

        return p(done => {
          const header = { core: 'METADRIVE', bin: this._bin.key.toString('hex')}
          this.append(header, done)
        })
      })

    // Fetch/Download local / remote header
      .then(() => {
        if (this._bin) return {action: NOP}
        debug('Waiting for binref header to be become available')
        return p(done => {
          this.get(0, (err, header) => {
            done(err, {action: CREATE_READABLE_FEED, header})
          })
        })
      })

    // Use the binRef key to initialize the reciever feed
    // happens only during replication and existing read-only feed load
      .then(({action, header}) => {
        if (action !== CREATE_READABLE_FEED) return
        debug('creating readonly binfeed')
        if (!header || header.core !== 'METADRIVE') throw new Error('Invalid feed header received')
        this._bin = hypercore(contentStorage, header.bin, Object.assign({}, this.opts, {valueEncoding: 'binary'}))
      })

    // Return the final binfeed
      .then( () => this._bin )

    if (typeof callback === 'function') {
      // This then/catch pattern lets our callstack correctly exit the
      // promise-chain, correctly propagating uncaught errors that might occur
      // after this method has ended.
      chain
        .then(binFeed => { process.nextTick( () => callback(null, binFeed) ) })
        .catch(err => { process.nextTick( () => callback(err) ) })
    } else {
      return chain
    }
  }

}
module.exports = (storage, key, opts) => new MetaDrive(storage, key, opts)

// A quick'n'dirty way to wrap es5 callback style methods
// inside a promise without having to 'promisify' every function individually
// usage:
// p(done => {
//  doSomething(err => {
//    if (err) return done(err)
//    doSomethingElse(done)
//  })
// })
function p(cb) {
  return new Promise(function(resolve, reject) {
    cb(function (err, ...p) {
      if (err) reject(err)
      // If our cb was called with a single parameter
      // then resolve it directly; otherwise resolve as an array.
      else resolve(p.length < 2 ? p[0] : p)
    })
  })
}
