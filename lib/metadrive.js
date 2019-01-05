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

  replicate (opts = {}) {
    opts.expectedFeeds = 2

    // when premade stream is passed.
    // tell it that we have an additional feed to replicate
    if (opts.stream) opts.stream.expectedFeeds++

    const sess = Math.floor(Math.random()*100)
    const stream = super.replicate(opts)

    let corked = false
    const spy = (err, chunk) => {
      debugger
    }

    debug('replicating meta', sess, this.key.toString('hex').substr(0,8))

    stream.on('end', () => {
      debug(sess, this.key.toString('hex').substr(0,8), 'finalizing', stream.expectedFeeds)
      if (!this._bin) debugger // It ended before binfeed even was initialized.
    })

    stream.on('prefinalize', (maybe => {
      if (!this._bin) {
        debugger
        stream.cork()
        corked = true
        debug(sess, 'WARNING, prefinalized emitted but binfeed is still not ready')
      }
      debug(sess, this.key.toString('hex').substr(0,8), 'prefinalizing', stream.expectedFeeds);
      // this._bin.removeListener('append', spy)
      // if(this._bin) maybe()
      return true
    }).bind(this))

    // Join the binfeed into repl stream once available
    this.binfeed((err, binfeed) => {
      debug(sess, this.key.toString('hex').substr(0,8), 'joining binfeed into replication', binfeed.key.toString('hex').substr(0,8))
      if (err) return stream.destroy(err)
      if (stream.destroyed) return

      binfeed.replicate({
        live: opts.live,
        download: opts.download,
        upload: opts.upload,
        stream
      })
      if (corked) debugger
    })

    return stream
  }
  /** returns the feed containing big-content
   * ensures that callback receives a usable binary-feed
   */
  binfeed (callback) {
    if (!callback) callback = () => {}
    if (this._bin) {
      return callback(null, this._bin)
    }

    super.ready(() => {
      this._initializeContent((err, feed) => {
        callback(err, feed)
      })
    })
  }

  _initializeContent (callback) {
    const contentStorage = (name, ...opts) => {
      return this.storage(path.join('content', name), ...opts)
    }

    const initWritable = (done) => {
      // Create binfeed if needed
      debug('creating writable binfeed')
      this._bin = hypercore(contentStorage, null, Object.assign({}, this.opts, {valueEncoding: 'binary'}))
      this._bin.ready(() => {
        // Quickreturn if header already witten
        if (this.has(0)) return done(null)
        //Create the binref header in meta-feed containing the binfeed pubkey
        debug('Appending binref header to meta')
        const header = { core: 'METADRIVE', bin: this._bin.key.toString('hex')}
        this.append(header, done)
      })
    }

    const initReadable = (done) => {
      // Fetch/Download local / remote header
      if (this._bin) return done()
      if (this.length < 0) done(new Error('bad drive, expected to have a header'))

      debug(this.key.toString('hex').substr(0,8),'Waiting for binref header to be become available')
      // Use the binRef key to initialize the reciever feed
      // happens only during replication and existing read-only feed load
      this.get(0, {wait: true}, (err, header) => {
        if (err) return done(err)
        if (!header || header.core !== 'METADRIVE') done(new Error('Invalid feed header received'))

        debug(this.key.toString('hex').substr(0,8), 'Waiting done! allocating remote feed', header.bin.substr(0,8))
        this._bin = hypercore(contentStorage, Buffer.from(header.bin, 'hex'), Object.assign({}, this.opts, {valueEncoding: 'binary'}))
        this._bin.ready(done)
      })
    }

    if (this.writable) {
      initWritable((err) => {
        callback(err, this._bin)
      })
    } else {
      initReadable((err) => {
        callback(err, this._bin)
      })
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
