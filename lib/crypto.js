var bufferFrom = require('buffer-from')
var bufferAlloc = require('buffer-alloc-unsafe')
var crypto = require('hypercore-crypto')
var sodium = require('sodium-universal')

module.exports.hashSecret = hashSecret
module.exports.subKey = subKey
module.exports.signPair = signPair

var CONTEXT_LOCAL_SIGN = module.exports.CONTEXT_LOCAL_SIGN = bufferFrom('__sign__')


/**
 * Hashes your password using a secret-hashing method
 *
 * @param secret String - Your personal secret
 * @param ident String - cluser-unique salt (Your name/email/username/spirit-animal)
 * @param len Number - Desired length of hash output
 * @return Buffer - A buffer with length `len` containing your hashed key
 */
function hashSecret (ident, secret, len) {
  // TODO: deriving salt by using first 16 bytes of SHA256(ident) feels very stupid
  // Help!
  var tmp = bufferAlloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(tmp, bufferFrom(`${ident}::hypervault`))
  var salt = bufferAlloc(sodium.crypto_pwhash_SALTBYTES)
  for (var i = 0; i < sodium.crypto_pwhash_SALTBYTES; i++) salt[i] = tmp[i]
  // pw hash
  var key = bufferAlloc(len)
  sodium.crypto_pwhash(
    key,
    bufferFrom(secret),
    salt,
    8,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    1
  )
  return key
}

/**
 * Derives a subkey of desired length from your credentials
 * @param ident String - cluser-unique salt (Your name/email/username/spirit-animal)
 * @param secret String - Your personal secret
 * @param len Number - Desired length of the subkey
 * @param context String - 8 characters string describing what the key is going to be used for
 * @param keyId Number - can be any value up to (2^64)-1 (optional, defaults 128)
 */
function subKey (ident, secret, len, context, keyId) {
  if (typeof keyId === 'undefined') keyId = 128
  var subkey = bufferAlloc(len)
  sodium.crypto_kdf_derive_from_key(
    subkey,
    keyId,
    bufferFrom(context),
    hashSecret(ident, secret, sodium.crypto_kdf_KEYBYTES)
  )
  return subkey
}

/**
 * Derives a signing pair from credentials
 * @param ident String - cluser-unique salt (Your name/email/username/spirit-animal)
 * @param secret String - Your personal secret
 * @param deviceId Number - can be any value up to (2^64)-1
 */
function signPair(ident, secret, deviceId) {
  deviceId = deviceId || 0
  // TODO: don't derive password into 16 bytes for
  // seed, even I understand that we're loosing entropy here.
  // we sould be able to generate the pairs more effectively?
  // Help!
  var seed = subKey(
    ident,
    secret,
    sodium.crypto_sign_SEEDBYTES, // 16
    CONTEXT_LOCAL_SIGN,
    deviceId
  )

  return crypto.keyPair(seed)
}
