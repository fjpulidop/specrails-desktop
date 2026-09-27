# HTTP fixture address-family isolation

27 September 2026. Two full server coverage runs exposed intermittent foreign
401 responses and connection resets in otherwise passing HTTP route suites.
A standalone Express/Supertest fixture reproduced a foreign `unauthorized`
response without loading application code. The server listened on `::` while
Supertest sent the request to `127.0.0.1`; this host permits an IPv4 listener and
an IPv6 listener to hold the same numeric port.

The regression binds an unrelated IPv4 service and an IPv6-only fixture to the
same port. Before the correction it deterministically received the unrelated
service's body. The shared test setup now preserves Supertest's server lifecycle
and directs wildcard/loopback IPv6 fixtures to `::1`. Explicit IPv4 fixtures and
explicit endpoint URLs retain their original addressing. The prototype adapter
is installed once per module instance. Production networking is unchanged.

Validation: the collision regression and two addressing controls pass; together
with the two affected route suites, 51 tests pass. Full typecheck passes. This
corrects transport ownership without retries, assertion relaxation or coverage
threshold changes. Full server coverage subsequently passed: 408 suites, 9,019 tests, seven
existing Windows-only omissions; 313.22s with two workers. Original coverage
thresholds pass (87.04% statements, 80.34% branches, 90.96% functions,
90.12% lines).
