// Verify contextRedaction: every secret shape that reaches `plano context` / dispatch context
// is redacted, and — just as important — ordinary terminal output is NOT. The second half is
// the one that keeps this file honest: a redactor that shreds legitimate output is a redactor
// people switch off, and then nothing is redacted at all.
//
// Runs against the dev checkout, no build and no app: it transpiles the one source file with
// esbuild (already a transitive dependency of electron-vite). Deliberately not Node's
// --experimental-strip-types, which needs Node >= 22.6 while Electron 33 embeds Node 20.
//
//   node tests/e2e/redaction-probe.mjs
//
// Every secret below is SYNTHETIC and built at runtime from repeated filler, so this file
// never contains anything shaped like a real credential for a scanner to flag.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { transformSync } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', '..', 'src', 'main', 'services', 'contextRedaction.ts')

const { code } = transformSync(readFileSync(SRC, 'utf8'), { loader: 'ts', format: 'esm', target: 'node18' })
const { redactContext } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

const hex64 = 'DEADBEEF'.repeat(8)
const txHash = 'a1b2c3d4'.repeat(8)
const txHash2 = 'f0e1d2c3'.repeat(8)
const b58 = 'z'.repeat(88)
const filler = (n) => 'A'.repeat(n)

// ── must be redacted ─────────────────────────────────────────────────────────
const MUST_REDACT = [
  // PEM — the PKCS#8 form (no infix) is the regression this probe exists for.
  ['pem-pkcs8-plain', `-----BEGIN PRIVATE KEY-----\n${filler(40)}\n-----END PRIVATE KEY-----`],
  ['pem-rsa', `-----BEGIN RSA PRIVATE KEY-----\n${filler(40)}\n-----END RSA PRIVATE KEY-----`],
  ['pem-openssh', `-----BEGIN OPENSSH PRIVATE KEY-----\n${filler(40)}\n-----END OPENSSH PRIVATE KEY-----`],
  ['pem-encrypted', `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${filler(40)}\n-----END ENCRYPTED PRIVATE KEY-----`],

  // Vendor-prefixed keys, pasted bare (no label, no Bearer).
  ['vendor-anthropic', `sk-ant-${filler(40)}`],
  ['vendor-openrouter', `sk-or-v1-${'b'.repeat(40)}`],
  ['vendor-openai-proj', `sk-proj-${filler(30)}`],
  ['vendor-openai', `sk-${'C'.repeat(40)}`],
  ['vendor-stripe-live', `sk_live_${filler(28)}`],
  ['vendor-paybox-live', `pbx_live_${filler(28)}`],
  ['vendor-google', `AIza${filler(35)}`],
  ['vendor-huggingface', `hf_${filler(34)}`],
  ['vendor-gitlab', `glpat-${filler(24)}`],
  ['vendor-npm', `npm_${filler(36)}`],
  ['vendor-in-prose', `the agent booted with pbx_live_${filler(28)} and then died`],

  // HD extended private keys (xpub siblings must NOT be caught — see MUST_NOT_REDACT).
  ['hd-xprv', `xprv${'9'.repeat(107)}`],
  ['hd-zprv', `zprv${'8'.repeat(107)}`],

  // Node-provider URLs whose key is a path segment or a query param. The URL IS the credential.
  ['rpc-quiknode-path', `https://fake-node.quiknode.pro/${filler(24)}/`],
  ['rpc-alchemy-path', `https://eth-mainnet.alchemy.com/v2/${filler(24)}`],
  ['rpc-infura-path', `https://mainnet.infura.io/v3/${filler(24)}`],
  ['rpc-helius-query', `https://rpc.helius-rpc.com/?api-key=${filler(20)}`],
  ['rpc-wss-path', `wss://fake-node.quiknode.pro/${filler(24)}/`],
  ['rpc-in-curl', `curl -s -X POST https://fake.quiknode.pro/${filler(24)}/ -d '{"method":"eth_blockNumber"}'`],
  ['url-query-token', `https://api.example.com/v1/things?token=${filler(20)}`],
  ['rpc-ankr-chain-path', `https://rpc.ankr.com/eth/${filler(24)}`],
  // Secret in BOTH path and query. The path pattern stops at the path, so if it runs first it
  // eats the scheme and strands `?key=…` with nothing left to anchor on. Order-dependent.
  ['rpc-path-and-query', `https://fake.quiknode.pro/${filler(24)}/?key=${filler(20)}`],

  // Raw key material WITH a risk word nearby — the contextual pattern.
  ['hex64-cast-flag', `cast send --private-key 0x${hex64} --rpc-url https://mainnet.base.org`],
  ['hex64-json', `{"private_key":"0x${hex64}","address":"0xAB"}`],
  ['hex64-export', `export PRIVATE_KEY=0x${hex64}`],
  ['hex64-docker', `docker run -e PRIVATE_KEY=0x${hex64} some/image:latest`],
  ['hex64-stacktrace', `ValueError: invalid private key 0x${hex64} (validation.py:88)`],
  ['hex64-no-0x-forge', `forge script Deploy.s.sol --broadcast --private-key ${hex64}`],
  ['hex64-keystore', `keystore decrypted -> 0x${hex64}`],
  ['hex64-python-repr', `>>> acct.key.hex()  # '0x${hex64}'`],
  ['b58-solana-secret', `solana secret key: ${b58}`],

  // Pre-existing coverage — these must keep working.
  ['bearer', `Authorization: Bearer ${filler(40)}`],
  ['aws-akia', `AKIA${'B'.repeat(16)}`],
  ['assignment', `export API_TOKEN=${filler(20)}`],
  ['labelled-secret', `secret: ${filler(20)}`],
]

// ── must survive untouched ───────────────────────────────────────────────────
const MUST_NOT_REDACT = [
  // Chain output. A 32-byte hash is byte-identical to a private key; these lines are the
  // reason the raw-key pattern is contextual rather than unconditional.
  ['tx-hash', `settle payment_tx 0x${txHash} status 0x1`],
  ['escrow-tx', `em_assign -> escrow_tx 0x${txHash2} escrow_locked_usd 0.05`],
  ['forge-tx-hash', `Transaction hash: 0x${txHash}`],
  ['block-hash', `blockHash: 0x${txHash} blockNumber: 48929062`],
  ['keccak-digest', `keccak256(abi.encode(...)) = 0x${txHash}`],
  ['eip712-digest', `signing typed-data digest 0x${txHash} via delegated signer`],
  ['eip3009-nonce', `nonce: 0x${txHash} validBefore: 1756000000`],
  ['merkle-root', `merkle root 0x${txHash}`],
  ['storage-slot', `cast storage 0xAB 0x${txHash}`],
  ['solidity-salt', `bytes32 constant SALT = 0x${txHash};`],
  ['explorer-url', `https://basescan.org/tx/0x${txHash}`],
  ['docker-digest', `digest: sha256:${txHash} size: 4291`],
  ['signature-r', `r: 0x${txHash}`],
  ['solana-tx-sig', `TERMINAL status=success tx=${'D'.repeat(88)} chain_id=1399811149`],

  // Public chain identifiers and ordinary URLs.
  ['evm-address', `USDC Base: 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`],
  ['zero-address', `zero address: 0x${'0'.repeat(40)}`],
  ['xpub-watch-only', `xpub${'9'.repeat(107)}`],
  ['public-rpc', `https://mainnet.base.org`],
  ['rpc-no-key', `https://rpc.ankr.com/eth`],
  ['github-url', `https://github.com/zqkra/plano/blob/main/README.md`],
  ['uuid', `Task 6c2a92e1-859f-48f3-941c-8454658eedd8, bounty $0.05`],
  ['git-sha', `commit 3c51063d0a1b2c3d4e5f60718293a4b5c6d7e8f9`],
  ['placeholder', `"value": "https://node.example.com/YOUR_API_KEY_HERE/"`],
  ['prose-about-keys', `never hardcode a private key in a repo; read it from the environment`],
  ['short-hex', `revert selector 0x151d90fe`],
  ['npm-version', `added 690 packages in 11s`],

  // Vendor prefixes sitting INSIDE ordinary words. `\b` cannot express this — these prefixes
  // begin with a word character, so only an explicit left boundary keeps `sk-` out of
  // ta/di/ri/kio-sk-, and `hf_`/`AIza`/`npm_` out of any word that happens to end in x.
  ['word-task-id', `job task-${'a1b2c3d4'.repeat(5)} done`],
  ['word-disk-label', `mounted disk-${'a1b2c3d4'.repeat(5)}`],
  ['word-risk-path', `./risk-${'a1b2c3d4'.repeat(5)}/out`],
  ['word-subtask', `subtask-${'a1b2c3d4'.repeat(5)}`],
  ['word-suffix-hf', `xhf_${'a1b2c3d4'.repeat(5)}`],
  ['word-suffix-aiza', `xAIza${'a1b2c3d4'.repeat(5)}`],
  // Ordinary words that start with an HD-key prefix.
  ['word-unprivileged', `uprvileged ${'a1b2c3d4'.repeat(8)}`],
  ['word-xprvate', `xprvate ${'a1b2c3d4'.repeat(8)}`],
  // Documentation URLs on provider hosts — the deep-link shape a wildcard path would eat.
  ['provider-docs-url', `https://www.alchemy.com/docs/how-to-add-a-custom-network`],
  ['provider-plain-path', `https://rpc.ankr.com/eth`],
]

const results = []
const record = (name, pass, observed, expected, error) =>
  results.push(error ? { name, pass, observed, expected, error } : { name, pass, observed, expected })

for (const [name, sample] of MUST_REDACT) {
  const { text, redactionCount } = redactContext(sample)
  const leaked = redactionCount === 0
  record(
    `redacts/${name}`,
    !leaked,
    leaked ? 'not redacted' : `${redactionCount} redaction(s)`,
    'redacted',
    leaked ? 'secret survived redaction' : undefined,
  )
  // A redaction that leaves the secret behind is worse than none: assert the secret body is
  // really gone. The needle is the longest alphanumeric run in the sample — in every case here
  // that IS the secret, and it deliberately ignores the surrounding command/URL, which is
  // expected to survive (`cast send --[REDACTED] --rpc-url https://…` is a correct result).
  //
  // A missing needle FAILS rather than passing quietly. This guard was silently vacuous for
  // any sample whose secret is dashed or dotted (a UUID-shaped key has no 20-char alphanumeric
  // run), which is exactly the case where it needed to speak up.
  if (!leaked) {
    const needle = (sample.match(/[A-Za-z0-9]{20,}/g) ?? []).sort((a, b) => b.length - a.length)[0]
    const stillThere = !needle || text.includes(needle)
    record(
      `scrubbed/${name}`,
      !stillThere,
      !needle ? 'no needle — guard would be vacuous' : stillThere ? 'secret body still present' : 'secret body gone',
      'secret body removed',
      stillThere ? 'matched but the secret is still in the output' : undefined,
    )
  }
}

// Pre-existing behaviour, recorded but NOT asserted: this predates the hardening (verified
// against the same input on the parent commit) and is left alone rather than "fixed" in a
// security patch. SENSITIVE_ASSIGN_RE takes `\S+` after the `=`, so an empty variable followed
// by a comment loses the comment. It over-redacts, which is the safe direction.
for (const [name, sample] of [['empty-assignment-eats-comment', `PRIVATE_KEY=  # Empty - fetched from AWS`]]) {
  const { redactionCount } = redactContext(sample)
  console.log(JSON.stringify({ name: `known-preexisting/${name}`, pass: true, observed: `${redactionCount} redaction(s)`, expected: 'documented, not asserted' }))
}

for (const [name, sample] of MUST_NOT_REDACT) {
  const { text, redactionCount } = redactContext(sample)
  const clobbered = redactionCount > 0
  record(
    `preserves/${name}`,
    !clobbered,
    clobbered ? `redacted: ${text}` : 'untouched',
    'untouched',
    clobbered ? 'legitimate output was redacted' : undefined,
  )
}

// Idempotence: running twice must not keep counting or mangle the marker.
const twice = redactContext(redactContext(`sk-ant-${filler(40)}`).text)
record('idempotent/second-pass', twice.redactionCount === 0, `${twice.redactionCount} redaction(s)`, '0 redaction(s)')

// Guard against catastrophic backtracking. This runs in Electron's MAIN process over
// arbitrary terminal transcripts, so the input is hostile by definition. Each case targets a
// pattern's worst shape: near-misses that force maximum backtracking before failing.
// Measured worst case at the time of writing: 92ms (the pre-existing PEM pattern).
const PATHOLOGICAL = [
  ['near-miss-hex64', `private key ${('0123456789abcdef'.repeat(3) + 'g ').repeat(2000)}`],
  ['risk-words-only', 'private key secret seed wallet keystore '.repeat(20000)],
  ['pem-begin-without-end', '-----BEGIN PRIVATE KEY-----\n'.repeat(5000)],
  ['near-miss-vendor', `${`sk-${'a'.repeat(31)} `.repeat(5000)}`],
  ['near-miss-base58', `${`seed ${'z'.repeat(86)} `.repeat(3000)}`],
  ['hostile-mix', `${`private key 0x${'a'.repeat(63)} sk-${'b'.repeat(31)} xprv${'9'.repeat(49)} `.repeat(400)}`],
]
for (const [name, input] of PATHOLOGICAL) {
  const started = Date.now()
  redactContext(input)
  const elapsedMs = Date.now() - started
  record(
    `perf/${name}`,
    elapsedMs < 2000,
    `${elapsedMs}ms for ${input.length} chars`,
    '< 2000ms',
    elapsedMs < 2000 ? undefined : 'possible catastrophic backtracking',
  )
}

for (const r of results) console.log(JSON.stringify(r))
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`FAILED: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
}
