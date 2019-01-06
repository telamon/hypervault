const network = require('@hyperswarm/network')
const pump = require('pump')
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
        debugger
        this.vault.reflect((err, changes) => {  // TODO; throttle
          if (err) console.log(err)
          this._reflecting = false
        })
      }
    })


    this.net.on('connection', this.onConnect.bind(this))
    this.net.join(this.vault.key, opts)

  }

  leave () {
    this.net.leave(this.vault.key)
  }

  onConnect (socket, details) {
    const live = !this.oneShot
    pump(socket, this.vault.replicate({live}), socket)
  }
}

module.exports = HypervaultSwarm
