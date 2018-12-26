var test = require('tape')
var bufferFrom = require('buffer-from')
var debug = require('debug')('kirin-core/test')
var kirinCrypto = require('../crypto')

test.createStream()
  .pipe(require('tap-spec')())
  .pipe(process.stdout)

test ('Derive key with arbitrary length from credentials', function (t){
  t.plan(2)
  var buf = kirinCrypto.hashSecret('telamohn@pm.me', 'supersecret', 16)
  debug('_hashSecret',  buf.toString('hex'))
  t.equal(buf.toString('hex'), 'cffeb02197b731d9fbab0a106b31f809')
  var buf2 = kirinCrypto.hashSecret('telamohn@pm.me', 'supersecret2', 16)
  t.notEqual(buf.toString('hex'), buf2.toString('hex'))
  t.end()
})

test ('Derive subkey from credentials', function(t) {
  t.plan(1)
  var sub = kirinCrypto.subKey('telamohn@pm.me', 'supersecret', 16, '__auth__', 1)
  debug('_subKey: ',  sub.toString('hex'))
  t.equal(sub.toString('hex'), 'a749e4c079b733ab6f46239d51c9274d')
  t.end()
})

test ('Derive keypair from credentials', function(t) {
  var pair = kirinCrypto.signPair('telamohn@pm.me', 'supersecret', 1)
  debug('_signPair', pair.publicKey.toString('hex'), pair.secretKey.toString('hex'))
  t.end()
})
