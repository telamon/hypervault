/**
 * A hypercore inspired by mafintosh/hyperdrive
 * Exception being that meta-data is first hand owned by external application.
 */
const hyperdrive = require('hyperdrive')
const hypercore = require('hypercore')

class MonkeyDrive extends hypercore {
  constructor (storage, key, opts) {
    if (!!key && typeof key !== 'string' && !Buffer.isBuffer(key)) {
      opts = key
      key = null
    }

    opts = opts || {}

    super(storage, key, Object.assign(opts, {
      sparse: opts.sparseMetadata,
      storageCacheSize: opts.metadataStorageCacheSize
    }))

    this.meta = new MonkeyMeta(this)
    this.drive = hyperdrive(storage, key, Object.assign(opts, {metadata: this.meta})
    )
  }

  __ready (callback) {
    super.ready(callback)
  }

  ready (callback) {
    super.ready((err) => {
      if (err) return callback(err)
      this.drive.ready(callback)
    })
  }
}

class MonkeyMeta {
  constructor (owner) {
    this.owner = owner
  }
  ready (cb) { this.owner.__ready(cb) } //  dummy
  // owner proxies
  on (...args)  { return this.owner.on(...args) }
  has (...args) { return this.owner.has(...args) }
  get (...args) { return this.owner.get(...args) }

  append (data, opts, callback) {
    debugger
  }
}

module.exports = (storage, key, opts) => new MonkeyDrive(storage, key, opts)

