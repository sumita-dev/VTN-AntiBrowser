/**
 * VNT-Browser Cipher Module
 * Implements the native Base64 substitution cipher (J -> M) expected by
 * `ReadAndMaybeDecryptConfigFile` (`RVA 0x335d1a0` in `chrome.dll` 151.0.7922.109).
 *
 * CRITICAL C++ BINARY INVARIANT:
 * `ReadAndMaybeDecryptConfigFile` checks if the first 3 bytes equal `"594"` (0x35, 0x39, 0x34).
 * Standard Base64 of `{"` is `eyI`, which maps to `"594"` under table M.
 * If an empty `{}` is encrypted (`e30=` -> `"520="`), `chrome.dll` skips decryption,
 * parses `520` as `Type::INT`, and crashes in `std::get<Dict>` (`bad_variant_access`).
 */

const J = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const M = 'hTy1bfRJz4nLPcBCO7WtmNIaGvVeul5Zo8kq32UxrYw_-0gsjp96SDFXQiEMKdHA';

/**
 * Encrypts a JSON object or non-empty string into the `"594..."` format required by `chrome.dll`.
 * Automatically injects `{"_v":"1"}` if an empty object is provided to prevent `bad_variant_access`.
 *
 * @param {Object|string} payload
 * @returns {string} Encrypted string guaranteed to start with `"594"` when given an object.
 */
function encryptConfig(payload) {
  let obj = payload;
  if (typeof payload === 'string') {
    try {
      obj = JSON.parse(payload);
    } catch {
      throw new Error('encryptConfig requires a valid JSON object or JSON string representing an object.');
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('encryptConfig target must be a JSON dictionary (base::Value::Dict).');
  }

  // Ensure at least one key so JSON starts with `{"` -> Base64 `eyI` -> Cipher `"594"`
  const safeObj = Object.keys(obj).length === 0 ? { _v: '1' } : obj;
  const plainText = JSON.stringify(safeObj);
  const b64 = Buffer.from(plainText, 'utf8').toString('base64');

  let out = '';
  for (let i = 0; i < b64.length; i++) {
    const ch = b64[i];
    const idx = J.indexOf(ch);
    out += idx !== -1 ? M[idx] : ch;
  }

  if (!out.startsWith('594')) {
    throw new Error(`CRITICAL: Encrypted payload does not start with "594" (got "${out.slice(0, 6)}"). This would crash chrome.dll!`);
  }
  return out;
}

/**
 * Decrypts a `"594..."` cipher string back into a UTF-8 JSON string and parses it.
 *
 * @param {string} cipherText
 * @param {boolean} [parseJson=true]
 * @returns {Object|string}
 */
function decryptConfig(cipherText, parseJson = true) {
  if (!cipherText || typeof cipherText !== 'string') {
    throw new Error('decryptConfig requires a non-empty cipher string.');
  }
  let b64 = '';
  for (let i = 0; i < cipherText.length; i++) {
    const ch = cipherText[i];
    const idx = M.indexOf(ch);
    b64 += idx !== -1 ? J[idx] : ch;
  }
  const utf8 = Buffer.from(b64, 'base64').toString('utf8');
  return parseJson ? JSON.parse(utf8) : utf8;
}

module.exports = {
  J,
  M,
  encryptConfig,
  decryptConfig
};
