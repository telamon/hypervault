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
    opts = Object.assign({lookup: true, announce: !this.oneShot}, opts)

    this.vault.fs.on('remote-update', (k, v) => {
      // TODO: no import if vault is read-only.
      // need to redefine readonly state of vault.
      if (!this._reflecting) {
        this._reflecting = true
        debug('Reflecting from remote event')
        this.vault.reflect((err, changes) => {  // TODO; throttle
          this._reflecting = false
          if (err) return console.log(err)
          console.log('Reflect result')
          console.table(changes)
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
          console.log('Reflect result')
          console.table(changes)
        })
      }
    }).bind(this))

    debug('Joining swarm on:', this.vault.key.toString('hex'))
    this.net.discovery.holepunchable((err, yes) => {
      if (err) console.error('Error while testing for holepunch capability', err)
      else if (yes) console.log('Your network is hole-punchable!')
      else console.log('Your network is not hole-punchable. This will degrade connectivity.')

      this.net.on('connection', this.onConnect.bind(this))
      // this.net.on('update', (...a) => debug('UPDATE EV:', ...a))
      this.net.on('peer', (peer) => debug('PEER Found:', peer.host))

      this.net.join(this.vault.key, {announce: true, lookup: true})
      //this.net.join(this.vault.key, opts)
    })

  }

  destroy (callback) {
    if (this.net.discovery.destroyed) return callback()
    // net.leave() does not destroy your swarm-presence
    // I'm assuming it was intended for topic-switching.
    // this.net.leave(this.vault.key)
    this.net.discovery.destroy()
    this.net.discovery.on('close', callback)
  }

  onConnect (socket, details) {
    debug('peer connected')
    const live = true // !this.oneShot
    const coreStream = this.vault.replicate({live})
    socket.once('error', () => {
      debug('REPL socket error', err)
      if (!socket.destroyed) socket.destroy()
      if (!coreStream.destroyed) coreStream.destoy()
    })
    coreStream.once('end', () => debug('REPL stream ended'))
    coreStream.once('error', (err) => debug('REPL stream error', err))
    coreStream.pipe(socket).pipe(coreStream)
  }
}

module.exports = HypervaultSwarm
