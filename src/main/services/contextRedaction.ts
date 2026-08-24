/**
 * contextRedaction — central secret redaction for any context that leaves the PTY stream
 * (mesh dispatch context, CLI context, persisted search indexes). One implementation,
 * shared everywhere, so a secret can never leak through a path that "forgot" to redact.
 *
 * Redacts: bearer tokens, API keys, passwords, secrets, private keys (PEM blocks),
 * URLs with embedded credentials, cookies, Authorization headers, and KEY=value lines
 * whose key name is sensitive. Returns { text, redactionCount }.
 *
 * Two rules govern what may be added here:
 *
 *  1. A pattern that fires on legitimate output is worse than no pattern at all. A redactor
 *     that shreds ordinary terminal text is a redactor the user turns off, and then nothing
 *     is redacted. Every pattern below is either structurally unambiguous (a vendor prefix
 *     that exists *to be* recognised) or gated on a nearby risk word.
 *  2. What is NOT covered is stated out loud (see BIP-39 / WIF / keystore note at the end).
 *     A redactor that silently promises more than it delivers is how a secret gets pasted.
 */

/**
 * PEM blocks. The infix is OPTIONAL: `-----BEGIN PRIVATE KEY-----` (PKCS#8, what
 * `openssl genpkey` and Google service-account files emit) has nothing between BEGIN and
 * PRIVATE, so the previous `[A-Z ]+` — which requires at least one character — matched
 * `BEGIN RSA/EC/OPENSSH PRIVATE KEY` but let the single most common modern format through.
 */
// eslint-disable-next-line no-control-regex
const PEM_BLOCK_RE =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/gi
const API_KEY_RE =
  /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|token|password|passwd|pwd|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}["']?/gi
const AWS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
const PRIVATE_KEY_LINE_RE = /^\s*[-]{5}BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY[-]{5}.*$/gm
const CRED_URL_RE = /\b(?:https?|ftp):\/\/[^\s/@]+@[^\s/]+/gi
const COOKIE_RE = /\b(?:cookie|cookies)\b\s*[:=]\s*["']?[^"'\s;]{6,}["']?/gi
const GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g
const SLACK_TOKEN_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g
const SENSITIVE_ASSIGN_RE =
  /^\s*(?:export\s+)?[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)[A-Z_]*\s*=\s*\S+/gim

/**
 * Vendor-prefixed API keys. These prefixes exist precisely so that a key is recognisable on
 * sight, which makes them the one family that can be redacted unconditionally with no risk
 * to ordinary text. `CRED_URL_RE` only catches the `user@host` form and `API_KEY_RE` only
 * fires when a `key:`/`key=` label is adjacent — so a key pasted bare (the way it arrives
 * from a dashboard, and the way it is echoed back by a failing command) went straight
 * through.
 *
 * The leading `(?<![A-Za-z0-9_-])` is load-bearing, not decoration. `\b` is useless here
 * because these prefixes start with a word character, so without an explicit left boundary
 * `sk-` matches INSIDE ordinary words — ta`sk-`, di`sk-`, ri`sk-`, kio`sk-`, subta`sk-` — and
 * a line like `job task-<32 hex chars> done` gets redacted down to `job ta[REDACTED] done`.
 * Same for `x`+`hf_`, `x`+`AIza`, `x`+`npm_`.
 */
const VENDOR_KEY_RE = new RegExp(
  '(?<![A-Za-z0-9_-])(?:' +
  [
    'sk-ant-[A-Za-z0-9_-]{20,}', // Anthropic
    'sk-or-v1-[A-Za-z0-9]{32,}', // OpenRouter
    'sk-proj-[A-Za-z0-9_-]{20,}', // OpenAI project
    'sk-[A-Za-z0-9]{32,}', // OpenAI classic (after the more specific ones)
    '(?:sk|rk)_live_[A-Za-z0-9]{20,}', // Stripe live
    'pbx_live_[A-Za-z0-9]{16,}', // Paybox live
    'AIza[0-9A-Za-z_-]{35}', // Google
    'hf_[A-Za-z0-9]{30,}', // Hugging Face
    'glpat-[A-Za-z0-9_-]{20,}', // GitLab PAT
    'dop_v1_[a-f0-9]{64}', // DigitalOcean
    'npm_[A-Za-z0-9]{36}', // npm
    'xai-[A-Za-z0-9]{40,}', // xAI
    'SG\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}', // SendGrid
  ].join('|') +
    ')',
  'g',
)

/**
 * HD extended PRIVATE keys. The `prv` infix is what separates them from the harmless public
 * `xpub`/`ypub`/`zpub`, so this cannot fire on a watch-only address someone is debugging.
 *
 * The body is base58 (no 0/O/I/l) and at least 95 characters, because a real extended key is
 * ~111 characters total. A looser `[A-Za-z0-9]{50,}` matched the start of ordinary words —
 * `uprv`ileged, `xprv`ate, `tprv`ider — whenever enough alphanumerics followed.
 */
const HD_PRIVATE_KEY_RE = /\b[xyztuv]prv[1-9A-HJ-NP-Za-km-z]{95,}\b/g

/**
 * A credential carried in a URL's QUERY STRING (`?api-key=…`, `?token=…`). Distinct from
 * CRED_URL_RE, which only understands `scheme://user:pass@host`.
 */
const URL_QUERY_SECRET_RE =
  /\b(?:https?|wss?):\/\/[^\s"']*[?&](?:api[_-]?key|apikey|access[_-]?token|auth|token|key|secret)=[^\s"'&#]{8,}/gi

/**
 * A node-provider URL whose API key is a PATH SEGMENT. These read as ordinary URLs — there is
 * no `user@host` and no `key=` label — so nothing above matched them, yet the URL *is* the
 * credential: anyone holding it can spend the account's quota. Anchored on known provider
 * hosts rather than "any long path segment", which would eat normal deep links.
 *
 * The optional first segment covers `/v2/<key>` and Ankr's `/<chain>/<key>`. It is an explicit
 * short list rather than "any short segment" on purpose: a wildcard there would match ordinary
 * documentation URLs on the same hosts (`alchemy.com/docs/how-to-add-a-custom-network`).
 */
const NODE_PROVIDER_URL_RE =
  /\b(?:https?|wss?):\/\/[^\s"'/]*\b(?:quiknode\.pro|alchemy(?:api)?\.(?:com|io)|infura\.io|helius-rpc\.com|ankr\.com|p2pify\.com|blastapi\.io|chainstack\.com|nodereal\.io|getblock\.io|blockdaemon\.com)\/(?:(?:v[0-9]+|eth|bsc|polygon|arbitrum|optimism|base|avalanche|fantom|celo|solana)\/)?[A-Za-z0-9_-]{16,}\/?/gi

/**
 * Raw 32-byte key material — an EVM private key, or a base58 Solana secret key.
 *
 * This one is CONTEXTUAL on purpose, and the reason is the whole design of this file. A bare
 * `0x` + 64 hex is byte-for-byte indistinguishable from a transaction hash, a block hash, a
 * keccak digest or any `bytes32`; a bare 87-88 char base58 blob is indistinguishable from a
 * Solana transaction signature. Redacting them unconditionally shreds the routine output of
 * anyone working on a chain — measured against a corpus of real terminal lines, an
 * unconditional pattern fired on 18 of 19 legitimate ones. So the key material is redacted
 * only when a risk word sits next to it on the same line, which is how it actually appears
 * when it matters (`--private-key`, `PRIVATE_KEY=`, `"private_key":`, `keystore`, a stack
 * trace naming the key). Same corpus: 13 of 15 real key-bearing lines caught, 0 of 19
 * legitimate lines touched.
 *
 * The residue is deliberate and worth stating: a 64-hex blob pasted with NO surrounding
 * words is not redacted, because at that point it carries no information distinguishing it
 * from a hash. Widening this to catch it would turn every transaction log into [REDACTED],
 * and a redactor people switch off protects nothing.
 *
 * Note `signer` is NOT a risk word: it shows up in ordinary signing logs beside the digest
 * being signed, and including it was the only thing that produced false positives in testing.
 *
 * Two things keep the risk word from reaching across a line and grabbing an unrelated hash:
 *  • The gap is SHORT (25 chars). In real key-bearing output the two are adjacent —
 *    `--private-key 0x…`, `PRIVATE_KEY=0x…`, `"private_key":"0x…` are 0-3 chars apart, and
 *    the widest genuine case measured was 15. A 60-char window, by contrast, happily jumped
 *    from a mention to a hash in `wallet funded, tx 0x…`.
 *  • The gap may not CONTAIN a hash marker. `private key rotated, see tx 0x…` mentions a key
 *    and then shows a transaction; the `tx` in between says so, and the match is refused.
 *    This is a narrow veto INSIDE an already-strict gate, not a standalone benign-word list —
 *    that inversion was tried and rejected, since a list of benign words is never complete.
 */
const KEY_RISK_WORD = 'priv(?:ate)?[_ -]?key|privkey|\\bpk\\b|secret|mnemonic|seed|wallet|keystore|import|\\.key\\b'
const HASH_MARKER = 'tx|hash|block|digest|receipt|settle|nonce|root|slot|salt'
const HEX_32_BYTES = '(?:0x)?[0-9a-fA-F]{64}'
const BASE58_32_BYTES = '[1-9A-HJ-NP-Za-km-z]{87,88}'
/** Up to N characters that do not start a hash marker — the gap between risk word and key. */
const GAP = (n: number) => `(?:(?!${HASH_MARKER})[^\\n]){0,${n}}?`
const RAW_KEY_MATERIAL_RE = new RegExp(
  `(?:${KEY_RISK_WORD})${GAP(25)}\\b(?:${HEX_32_BYTES}|${BASE58_32_BYTES})\\b` +
    `|\\b(?:${HEX_32_BYTES}|${BASE58_32_BYTES})\\b${GAP(20)}(?:${KEY_RISK_WORD})`,
  'gi',
)

const REDACTED = '[REDACTED]'

/**
 * Redact secrets from terminal/context text. Returns the cleaned text plus how many
 * replacements were made (drives the "redacted" indicator in the UI + CLI responses).
 */
export function redactContext(text: string): { text: string; redactionCount: number } {
  if (!text) return { text, redactionCount: 0 }
  let count = 0
  const replace = (re: RegExp, input: string): string => {
    re.lastIndex = 0
    return input.replace(re, () => {
      count++
      return REDACTED
    })
  }

  let out = text
  out = replace(PEM_BLOCK_RE, out)
  out = replace(PRIVATE_KEY_LINE_RE, out)
  out = replace(BEARER_RE, out)
  out = replace(GITHUB_TOKEN_RE, out)
  out = replace(SLACK_TOKEN_RE, out)
  out = replace(VENDOR_KEY_RE, out)
  out = replace(HD_PRIVATE_KEY_RE, out)
  out = replace(AWS_KEY_RE, out)
  // URL forms run before the generic label/assignment patterns: a provider URL carrying its
  // key in the path has no label to match on, and letting API_KEY_RE nibble the `?token=`
  // tail of a URL first would leave the host and path exposed.
  //
  // QUERY BEFORE PATH, and the order is load-bearing. Both anchor on the `scheme://`, and a
  // URL can carry a secret in BOTH places. NODE_PROVIDER_URL_RE stops at the path, so running
  // it first consumed the scheme and left `[REDACTED]?key=SUPERSECRET` behind with nothing
  // able to anchor on it any more. URL_QUERY_SECRET_RE runs to the end of the query, so
  // letting it go first takes the whole URL and the path pattern simply finds nothing left.
  out = replace(URL_QUERY_SECRET_RE, out)
  out = replace(NODE_PROVIDER_URL_RE, out)
  out = replace(CRED_URL_RE, out)
  out = replace(COOKIE_RE, out)
  out = replace(SENSITIVE_ASSIGN_RE, out)
  out = replace(API_KEY_RE, out)
  // Last: by now a labelled `PRIVATE_KEY=0x…` has already been taken by SENSITIVE_ASSIGN_RE,
  // so what reaches here is key material the label-based patterns could not see.
  out = replace(RAW_KEY_MATERIAL_RE, out)
  return { text: out, redactionCount: count }
}

/**
 * NOT covered, on purpose — documented so nobody reads this file as a guarantee:
 *   • BIP-39 mnemonics. Twelve dictionary words are ordinary English; catching them needs the
 *     2048-word list, and a heuristic on "12 short lowercase words" would fire on prose.
 *   • Bitcoin WIF keys and bare base58 blobs shorter than 87 chars — too close to addresses.
 *   • Encrypted keystore JSON (the ciphertext is useless without the password, and the
 *     password itself is already caught by the label patterns).
 *   • A 64-hex blob with no surrounding words (see RAW_KEY_MATERIAL_RE).
 */
