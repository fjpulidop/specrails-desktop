# Implementation efficiency evaluation

Mode: offline. synthetic-fixture-usage; no actual AI savings measured.

Monetary target: 20% lower aggregate cost per independently accepted output. Conclusion: inconclusive.

{
  "full": {
    "samples": 5,
    "independentlyAccepted": 5,
    "costPerAcceptedUsd": null,
    "medianActiveDurationMs": 10173,
    "minActiveDurationMs": 9718,
    "maxActiveDurationMs": 13922,
    "standardDeviationMs": 1624.2063415711687
  },
  "optimized": {
    "samples": 5,
    "independentlyAccepted": 5,
    "costPerAcceptedUsd": null,
    "medianActiveDurationMs": 10103,
    "minActiveDurationMs": 9566,
    "maxActiveDurationMs": 14355,
    "standardDeviationMs": 1781.4247107301503
  }
}

Correction prompt comparison: [{"caseId":"verification-correction","repeat":0,"fullBytes":4859,"optimizedBytes":1777,"reduction":0.6342868903066474}]

- static-tetris, full: succeeded; independent acceptance true; 9764 ms
- static-tetris, optimized: succeeded; independent acceptance true; 9964 ms
- local-tested-feature, full: succeeded; independent acceptance true; 9718 ms
- local-tested-feature, optimized: succeeded; independent acceptance true; 9566 ms
- cross-repository-contract, full: succeeded; independent acceptance true; 10173 ms
- cross-repository-contract, optimized: succeeded; independent acceptance true; 10103 ms
- verification-correction, full: succeeded; independent acceptance true; 11920 ms
- verification-correction, optimized: succeeded; independent acceptance true; 11917 ms
- review-correction, full: succeeded; independent acceptance true; 13922 ms
- review-correction, optimized: succeeded; independent acceptance true; 14355 ms

No paid benchmark has established monetary savings.
