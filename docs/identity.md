# identity — the derivation contract

Chlorum has exactly one secret that matters: `CHLORUM_ADMIN_TOKEN`.
Everything else is derived, on demand, on both ends.

## wire key (profile key)

```
profileKey = SHA-256( "chlorum-node-key:" + taskId )   // hex, 64 chars
```

Both the node and the console compute this value independently.
It seals every reagent envelope (AES-256-CBC over deflated JSON,
random salt + IV per message). The node therefore needs no secret
beyond its deployment identity — and the identity string is, by
design, the credential. If an identity leaks, rotate the token:
every node derived from the old token dies on its next poll.

## vault key

```
vaultKey = utf8( taskId + ":" + adminToken )
```

Vault files on disk are ChaCha20-Poly1305 sealed under a scrypt-
stretched vault key with a random 16-byte salt and 12-byte nonce per
file. The console recomputes the vault key when an operator opens a
file, so no key material is ever persisted. A node's own local vault
copy is sealed under the task id alone (a weaker, node-local key —
acceptable because the console copy is the strong one).

## reagent envelope

```
"REAG" | salt(8) | iv(16) | AES-256-CBC( deflate( json ) )
key     = SHA-256( profileKey + ":" + salt-hex )
```

Random salt per envelope means identical plaintexts produce
unrelated ciphertexts; passive observers get neither structure nor
length correlation beyond the deflate ratio.

## what the master token protects

- vault confidentiality (files are useless without it)
- nothing on the node wire (identity string protects that)

This split is deliberate: a compromised node burns one identity, a
compromised console burns everything. Rotate the token after any
console-side suspicion; nodes re-derive nothing and simply stop
being acknowledged.
