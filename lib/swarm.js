const network = require('@hyperswarm/network')
const pump = require('pump')
const watch = require('node-watch')
const path = require('path')
const debug = require('debug')('hypervault/swarm')
const und = require('underscore')
const mutexify = require('mutexify')

class HypervaultSwarm {
  constructor (vault, opts = {}) {
    // Watch folder for changes by default if
    // vault is not bare or not requested to do one-shot.
    this.opts = opts
    this.oneShot = !opts.noWatch && !vault.bare
    this.vault = vault
    this.net = network(this.opts)


    // Setup change synchronized change-handler that triggers folder
    // updates on remote and local events.
    this.replock = mutexify()
    const self = this
    this._onChange = und.debounce(() => {
      // avoid concurrent reflections
      self.replock(unlock => {
        self.vault.reflect((err, changes) => {
          if (err){
            console.log("Error during reflect", err)
          } else {
            console.log('Reflect results:')
            console.table(changes)
          }
          unlock()
        })
      })
    },500) // change events usually arrive in batches for each changed file.
    // wait at least 500ms before triggering a complete folder-reflect.
  }

  join (opts = {}) {
    opts = Object.assign({lookup: true, announce: !this.oneShot}, opts)

    // Setup remote event change listener.
    this.vault.fs.on('remote-update', this._onChange)

    // Setup local folder change listener
    const watchOpts = {
      recursive: true,
      filter: f => !/^.hypervault/.test(path.relative(this.vault.repo, f))
    }
    watch(this.vault.repo, watchOpts, this._onChange)

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
    socket.once('error', (err) => {
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

