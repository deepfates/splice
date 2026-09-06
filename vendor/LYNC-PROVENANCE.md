# Vendored Lync package

`deepfates-lync-0.4.3-828a140.tgz` was produced once with `pnpm pack` from the
clean `@deepfates/lync` checkout at commit
`828a14017ea71519c510b0808a49d6382a36ed33` (tree
`f24e6122012f24beea934a1f639117ab15694725`).

- Declared package version: `0.4.3`
- Archive size: 192,037 bytes
- Archive SHA-256: `cc90bfc8766ecab7c7ab53298ca0fdff8e3649626879f6cab7300c071e566196`
- Required unpublished surface: `@deepfates/lync/presentation`
- Producer verification: frozen install, 223 tests in 26 files, typecheck,
  executable examples, and the physical packed-artifact check passed before
  this archive was retained.

This exact source-pinned package makes the Splice source checkout reproducible
without a sibling `node_modules` link or a registry publication. It is a
dependency boundary, not a fork: Lync continues to own event parsing, views,
identity, and presentation semantics.

Splice's npm package does not include this `vendor/` directory. Do not treat
this source-checkout dependency as evidence that the unreleased Splice 0.4
package is publishable or registry-installable.
