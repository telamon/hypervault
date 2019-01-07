const path = require('path')
const fs = require('fs')
const pump = require('pump')
const debug = require('debug')('hypervault/reflect')
module.exports = reflect
module.exports._indexFolder = _indexFolder

const REFLECT_CACHE = 'reflect_cache'

/*
 * Reflects the kappa-drive view to disk and vice-versa
 * This approach causes our repo to always require minimum twice the
 * size of the files it stores (git-style). Alternative is to use a FUSE based approach
 * https://github.com/mafintosh/fuse-bindings
 *
 * Given entries:
 *  for each unique file:
      const a = kappafs[file]
      const o = snapshotAfterPreviousReflect[file] // Needed to detect deletes
      const b = localfs[file]

   Exploring possible outcomes based on existance of a file-record
 |---+---+---+-----------------------+--------------------------------|
 | B | O | A | action                | note                           |
 |---+---+---+-----------------------+--------------------------------|
 | 1 | 0 | 0 | EXPORT                | Unconditional export           |
 | 0 | 0 | 1 | IMPORT                | Unconditional import           |
 | 0 | 0 | 0 | NOP                   | Unconditional nop              |
 | 0 | 1 | 1 | NOP                   | kappafs corrupt/ still loading |
 | 0 | 1 | 0 | NOP                   | Invalid cache (auto heals)     |
 | 1 | 0 | 1 | RERUN                 | O = B; next(i)                 |
 | 1 | 1 | 0 | CMP & DEL/EXP         | otime >= btime ? KILL : EXPORT |
 | 1 | 1 | 1 | CMP & IMP/EXP/NOP/DEL | I hate sync                    |
 |---+---+---+-----------------------+--------------------------------|

  Simpliest logical approach is to
  1. fast-track the unconditional operations
  2. handle the conflict CMP for Delete vs Export
    if (O.time >= B.time) hyperfs.unlink(file) // when user deletes the latest version
    else export new version  // When user deleted a file but a newer version is available (causes file to reappear)
  3. And lastly some big nested logic to handle the CMP & IMP/EXP/NOP/DEL
  situation where entries exists in all 3 domains.
 */
function reflect(done, opts = {}) {
  opts = Object.assign({wait: true}, opts || {})
  const changeLog = {}

  // Handle errors and persist a new last-synchronized state to storage
  const finish = (err) => {
    if (err) return done(err)
    this.indexView((err, tree) => {
      saveReflectCache(this._storage, tree, (err) => {
        if (err) done(err)
        else done(null, changeLog)
      })
    })
  }

  this.indexView((err, hyperTree) => {
    if (err) return finish(err)
    fetchReflectCache(this._storage, (err, snapshot) => {
      if (err && err.code === 'ENOENT') snapshot = {}

      else if(err) return finish(err)

      _indexFolder(this.repo, (err, fsTree) => {
        if (err) return finish(err)

        // Calculate list of unique known entries
        const uniqueEntries = Object.keys(
          Object.keys(hyperTree)
          .concat(Object.keys(fsTree))
          .reduce((m,f) => { m[f]=true; return m }, {})
        )

        const nextEntry = (i) => {
          if (i >= uniqueEntries.length) return finish(null) // End the loop
          const file = uniqueEntries[i]

          // ACTIONS
          const exp = () => {
            this.exportFile(file, path.join(this.repo, file), {wait: !!opts.wait}, err => {
              changeLog[file] = {action: 'export', err}
              nextEntry(i + 1)
            })
          }

          const imp = () => {
            this.importFile(file, path.join(this.repo, file), err => {
              changeLog[file] = {action: 'import', err}
              nextEntry(i + 1)
            })
          }

          const del = () => {
            return this.unlink(file, (err) => {
              changeLog[file] = {action: 'delete', err}
              nextEntry(i + 1)
            })
          }

          const nop = (err) => {
            changeLog[file] = {action: 'nop', err}
            nextEntry(i + 1)
          }


          // SYNC-LOGIC
          const b = hyperTree[file] // Remote entry
          const a = fsTree[file] // Local entry
          const o = snapshot[file] // Last synchronized state

          // NO-OP situations
          if (!b && o && a) return nop('kappafs entry missing')
          if (!b && o && !a) return nop('ghost in cache')
          if (b && !o && a) { snapshot[file] = hyperTree[file]; return nextEntry(i) } // Rerun

          // Unconditional export
          if (b && !o && !a) return exp()
          // Unconditional import
          if (!b && !o && a) return imp()

          // File locally deleted but may reappear if remote has newer version.
          if (b && o && !a) {
            // File locally deleted
            if (!b.deleted && b.mtime <= o.mtime) {
              return del()
            }
            // newer version available than the one deleted
            if (!b.deleted && b.mtime > o.mtime) {
              return exp()
            }
          }

          // Perform 3-way merge
          if (b && o && a) {
            // Theoretically o.mtime should equal Math.min(a.mtime, b.mtime)
            const aDiverged = a.mtime > o.mtime
            const bDiverged = b.mtime > o.mtime

            // Import local changes
            if (aDiverged && !bDiverged) {
              return imp()
            }
            // Reflect remote changes
            if (bDiverged && !aDiverged) {
              return b.deleted ? del() : exp()
            }
            // No diversions
            if (!bDiverged && !aDiverged) return nop('aleady in sync')

            // Both diverged

            // B is newer
            if (b.mtime >= a.mime) return b.deleted ? del() : exp()
            // A is newer
            if (b.mtime < a.mime) return imp()
          }

          return nop('unhandled scenario, most likely a bug')
        } // end of nextEntry()
        nextEntry(0)
      })
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

function saveReflectCache (storage, data, done) {
  if (typeof done !== 'function') done = function(err) { if(err) throw err }
  const file = storage(REFLECT_CACHE)
  const cleanup = (err) => {
    file.close()
    done(err)
  }

  const buf = Buffer.from(JSON.stringify(data))
  const sizeBuf = Buffer.alloc(4)
  sizeBuf.writeUInt32LE(buf.length)
  file.write(0, sizeBuf, function(err) {
    if (err) return cleanup(err)
    file.write(4, buf, cleanup)
  })
}

function fetchReflectCache (storage, done) {
  if (typeof done !== 'function') done = function(err) { if(err) throw err }
  const file = storage(REFLECT_CACHE)
  const cleanup = (err, tree) => {
    file.close()
    done(err, tree)
  }

  file.read(0,4, (err, chunk) => {
    if (err) return cleanup(err)
    var size = chunk.readUInt32LE()

    file.read(4, size, (err, chunk) => {
      if (err) return cleanup(err)
      try {
        const tree = JSON.parse(chunk.toString('utf8'))
        cleanup(null, tree)
      } catch (err) { cleanup(err) }
    })
  })
}

