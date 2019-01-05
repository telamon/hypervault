const path = require('path')
const fs = require('fs')
const pump = require('pump')
const debug = require('debug')('hypervault/reflect')
module.exports = reflect
module.exports._indexFolder = _indexFolder

const REFLECT_CACHE = 'reflect_cache'
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

/*
 * Reflects the kappa-drive view to disk and vice-versa
 * This approach causes our repo to always require minimum twice the
 * size of the files it stores (git-style). Alternative is to use a FUSE based approach
 * https://github.com/mafintosh/fuse-bindings
 * Which incidentially would let us access encrypted files without being forced
 * of writing their unencrypted contents to actual disk.
 * TODO: Use reflection only when FUSE is not available.
 *
 * Given entries:
 *  for each unique file:
      const hstat = kappafs[file]
      const fstat = localfs[file]
      const cstat = snapshotAfterPreviousReflect[file] // Needed to detect deletes

   Exploring possible outcomes
 |-------+-------+-------+-------------------+--------------------------------|
 | hstat | cache | local | action            | note                           |
 |-------+-------+-------+-------------------+--------------------------------|
 | 1     | 0     | 0     | EXPORT            | Unconditional export           |
 | 1     | 1     | 0     | CMP & KILL/EXP    | ctime >= htime ? KILL : EXPORT |
 | 1     | 1     | 1     | CMP & IMP/EXP/NOP | I hate sync                    |
 | 0     | 1     | 1     | NOP               | kappafs corrupt/ still loading |
 | 0     | 0     | 1     | IMPORT            | Uncondtional import            |
 | 0     | 0     | 0     | NOP               | Unconditoinal nop              |
 | 0     | 1     | 0     | NOP               | Invalid cache                  |
 | 1     | 0     | 1     | RERUN             | cstat = hstat; next(i)         |
 |-------+-------+-------+-------------------+--------------------------------|
 */
function reflect(cb) {
  const changeLog = {}
  fetchReflectCache(this._storage, (err, cache) => {
    if (err && err.code === 'ENOENT') cache = {}
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
          const cstat = cache[file]
          const remoteDead = hstat && hstat.deleted
          const localDead = cstat && cstat.deleted


          if (hstat && hstat.deleted && fstat.mtime < hstat.mtime) action = 'delete-local' // losses offline changes
          // export if file only known by hypertree
          else if (hstat && !fstat && !cstat) action = 'export'
          // export if previously deleted file was reeadded remotley
          else if (hstat && !remoteDead && localDead
          else if (!hstat && fstat) action = 'import'
          else if 
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

