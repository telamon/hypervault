const path = require('path')
const fs = require('fs')
const pump = require('pump')

module.exports = reflect
module.exports._indexFolder = _indexFolder
/*
 * Reflects the combined hyperdrive view to disk and vice-versa
 * This approach causes our repo to always require minimum twice the
 * size of the files it stores (git-style). Alternative is to use a FUSE based approach
 * https://github.com/mafintosh/fuse-bindings
 * Which incidentially would let us access encrypted files without being forced
 * of writing their unencrypted contents to actual disk.
 * Use reflection only when FUSE is not available.
 */
function reflect(cb) {
  const changeLog = {}

  this.indexView((err, hyperTree) => {
    if (err) return cb(err)

    _indexFolder(this.repo, (err, fsTree) => {
      if (err) return cb(err)

      // Calculate list of unique known entries
      const uniqueEntries = Object.keys(
        Object.keys(hyperTree)
        .concat(Object.keys(fsTree))
        .reduce((m,f) => { m[f]=true; return m }, {})
      )

      const nextEntry = (i) => {
        if (i >= uniqueEntries.length) return cb(null, changeLog)
        const file = uniqueEntries[i]

        // Decide what to do with it
        let action = 'nop'
        const hstat = hyperTree[file]
        const fstat = fsTree[file]

        if (hstat && hstat.deleted && fstat.mtime < hstat.mtime) action = 'delete-local' // losses offline changes
        else if (hstat && !fstat) action = 'export'
        else if (!hstat && fstat) action = 'import'
        else if (hstat && fstat) {
          debug('REFLECT: comparing', file, hstat.mtime, fstat.mtime)
          // prototype conflict resolution using mtime (pick newest)
          if (hstat.mtime < fstat.mtime) action = 'import'
          else if (hstat.mtime > fstat.mtime) action = 'export'
        }

        debug('REFLECT:', action.toUpperCase(), '\t\t', file)
        changeLog[file] = action

        // Import if needed TODO: stop importing deleted entries.
        if (action === 'import' && this.canWrite) {
          importFile(this._local, this.repo, file, fstat, err => {
            if (err) return cb(err)
            else nextEntry(i + 1)
          })
        }

        // Export if needed
        if (action === 'export' && !this.bare) {
          let srcFeed = this.multi.feeds().find(f => f.discoveryKey.toString('hex'), [hstat.feed])
          exportFile(srcFeed, this.repo, file, hstat, err => {
            if (err) return cb(err)
            else nextEntry(i + 1)
          })
        }

        // No op
        if (action === 'nop') nextEntry(i + 1)
      } // end of nextEntry()
      nextEntry(0)
    })
  })

  // reflect helpers
  function exportFile(feed, dst, file, stat, cb) {
    let dstPath = path.join(dst, file)
    // TODO: don't call mkdirSync on every pass, cache which dirs have already been
    // created during an reflect op to avoid trying to recreate them.
    fs.mkdirSync(path.dirname(dstPath),{ recursive: true })
    pump(feed.createReadStream(file), fs.createWriteStream(dstPath), err => {
      if (err) return cb(err)
      // Fix mtime to match stored stat in hyperdrive
      fs.open(dstPath, 'w', (err, fd) => {
        if (err) return done(err)
        fs.futimes(fd, stat.mtime / 1000, stat.mtime / 1000, (err) => {
          fs.close(fd, (err) => {'nop'}) // unconditional cleanup
          if(err) cb(err)
          else cb()
        })
      })
    })
  }

  function importFile(writer, dst, file, stat, cb) {
    pump(
      fs.createReadStream(path.join(dst, file)),
      writer.createWriteStream(file, {mtime: stat.mtime}),
      cb
    )
  }
}


/** Calculates a flat hash containing keys as files using full path from repo-root,
 * and values contain indicators required for synchronization.
 *
 * @param arch {Hyperdrive|String} if string provded, will index folder from
 * local filsystem; It can index hyperdrives but it's not optimal.
 * @param dir {String} sub directory to index, defaults to `/`
 */
function _indexFolder(arch, dir, cb) {
  if (typeof dir === 'function') { cb = dir; dir = null}
  if (!dir) dir = '/'
  const tree = {}

  // Consider it being a real filesystem if arch equals string
  const isHyperdrive = typeof arch !== 'string'

  const readdir = (file, done) => {
    if (isHyperdrive) arch.readdir(file, done)
    else fs.readdir(path.join(arch, file), done)
  }
  const lstat = (file, done) => {
    if (isHyperdrive) arch.lstat(file, done)
    else fs.lstat(path.join(arch, file), done)
  }

  const traverseDir = (subDir, dirDone) => {
    //debug('INDEX: traversing dir:', subDir)
    readdir(subDir, (err, list) => {
      if (err) return cb(err)
      const next = (i) => {
        if (i >= list.length) return dirDone()
        const entry = list[i]
        const fpath = path.join(subDir, entry)
        //debug('INDEX: processing entry:', fpath)

        // TODO: better ignore, hardcoding dosen't sit right.
        if (fpath.match(/^\/.hypervault/)) return next(i + 1)

        lstat(fpath, (err, stat) => {
          if (err) return cb(err)
          if (stat.isDirectory()) {
            traverseDir(fpath, (err) => {
              if (err) cb(err) // Abort _indexFolder with err
              else next(i + 1) // continue to next entry
            })
          } else if (stat.isFile()) {
            // Common keys
            let n = {
              size: stat.size,
              mtime: new Date(stat.mtime).getTime(),
              ctime: new Date(stat.ctime).getTime()
            }
            // Hyperdrive only keys
            if (isHyperdrive) {
              n.feed = arch.name
            }
            tree[fpath] = n
            next( i + 1 )
          } else {
            // only dir and plain file support right now.
            // symlinks can be patched in later.
            // continue to next if entry isn't supported
            next( i + 1 )
          }
        })
      }

      // Start processing the list from 0-nth entry
      next(0)
    })
  }

  // Start the loop from provided `dir` argument.
  // if no errors were thrown during the entire process
  // then call the tee.
  traverseDir(dir, (err) => {
    if (err) cb(err)
    else cb(null, tree)
  })
}

