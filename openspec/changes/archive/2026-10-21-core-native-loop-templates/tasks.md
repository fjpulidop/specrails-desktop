## 1. Catalog

- [x] 1.1 Serve only `CORE_STARTER_TEMPLATE_IDS` from `LOOP_TEMPLATES`; drop the `opsx-lifecycle` entry while keeping `opsxLifecycleGraph` for the legacy Quick SDD factory
- [x] 1.2 Delete `loop-templates-ported.ts`, `PortSpec` and `compilePortSpec`; update the boundary manifest
- [x] 1.3 Remove the 35 ported catalog strings from the 8 locales

## 2. Tests and docs

- [x] 2.1 Replace ported/size-floor template tests with an exact Core-starter catalog assertion; assert `opsx-lifecycle` is not a template
- [x] 2.2 Regenerate the source map and note the catalog scope in the loops module README
- [x] 2.3 Typecheck, loops module tests, architecture audit and client loops tests
