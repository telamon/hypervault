const network = require('@hyperswarm/network')
const pump = require('pump')
const watch = require('node-watch')
const path = require('path')
const debug = require('debug')('hypervault/swarm')
class HypervaultSwarm {
  constructor (vault, opts = {}) {
    // Watch folder for changes by default if
    // vault is not bare or not requested to do one-shot.
    this.opts = opts
    this.oneShot = !opts.noWatch && !vault.bare
    this.vault = vault
    this.net = network(this.opts)
  }

  join (opts = {}) {
    if (this.oneShot) opts = Object.assign(opts, {
      lookup: true,
      announce: false
    })

    this.vault.fs.on('remote-update', (k, v) => {
      // TODO: no import if vault is read-only.
      // need to redefine readonly state of vault.
      if (!this._reflecting) {
        this._reflecting = true
        debug('Reflecting from remote event')
        this.vault.reflect((err, changes) => {  // TODO; throttle
          this._reflecting = false
          if (err) return console.log(err)
          console.log('Reflect result\n', JSON.stringify(changes, null, 2))
        })
      }
    })

    const watchOpts = {
      recursive: true,
      filter: f => !/^.hypervault/.test(path.relative(this.vault.repo, f))
    }

    watch(this.vault.repo, watchOpts, ((evt, name) => {
      debug('Watch trigger', evt, name)
      if (!this._reflecting) {
        this._reflecting = true
        debug('Reflecting from local event')
        this.vault.reflect((err, changes) => {  // TODO; throttle
          this._reflecting = false
          if (err) return console.log(err)
          console.log('Reflect result\n', JSON.stringify(changes, null, 2))
        })
      }
    }).bind(this))

    this.net.on('connection', this.onConnect.bind(this))
    this.net.join(this.vault.key, opts)

  }

  leave () {
    this.net.leave(this.vault.key)
  }

  onConnect (socket, details) {
    debug('peer connected')
    const live = !this.oneShot
    pump(socket, this.vault.replicate({live}), socket)
  }
}

module.exports = HypervaultSwarm
