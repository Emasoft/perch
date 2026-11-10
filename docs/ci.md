---
title: perch in CI
nav: perch in CI
group: Using perch
order: 6
summary: Scan every pull request with GitHub Actions, GitLab CI or any other CI provider.
---

# perch in CI

Add a job to GitHub Actions, GitLab CI or any other CI provider that runs `perch scan` against the endpoint you configured,
and the job fails when the scan finds something.

## GitHub Actions

To run Perch in GitHub Actions, add the following workflow to `.github/workflows/perch.yml`, with the key in a repository
secret:

```yaml
name: perch
on: pull_request

permissions:
  contents: read

jobs:
  perch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # --since needs the base branch's history.
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx --yes @lakeday/perch scan --since origin/${{ github.base_ref }}
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

If a pull request introduces a bug, the job fails with output like this:

```console
$ perch scan --since origin/main
cart.py
  ID        Line  Severity  Type    Confidence  Problem             Method
  48a02173    15  P1 (1.0)  defect         88%  wrong_return_value  apply_discount
  44c8d48a    21  P1 (1.3)  defect         86%  inverted_condition  is_eligible_for_free_shipping
  80d6ebbb    28  P1 (1.3)  defect         91%  unhandled_null      cheapest

✖ 3 problems in 1 file, all failing
order-service at commit e648e44: 4 methods, read 3
3 requests  4k tokens in / 439 out  $0.0012
```

Any other endpoint works the same way. Set `PERCH_BASE_URL` to it, and the key to whatever `PERCH_API_KEY` names for that URL:
`OPENAI_API_KEY` when it ends in `/decisions`, `TYPESAFE_API_KEY` otherwise. For the list of supported endpoints, see
[Environment](/cli/#environment).

The fallback to a local model does not reach CI: a runner is not Apple silicon and nobody is there to install one. `perch
doctor` says so, and a spent window fails the job as it did before.

## GitLab CI

Add this job to `.gitlab-ci.yml`, with the key as a masked CI/CD variable named `OPENAI_API_KEY`:

```yaml
perch:
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: 0
  script:
    - git fetch origin $CI_MERGE_REQUEST_TARGET_BRANCH_NAME
    - npx --yes @lakeday/perch scan --since origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The scan didn't find anything that fails it. |
| 1 | Perch couldn't run, or couldn't read some methods after retrying. |
| 2 | The command was invalid. |
| 3 | The scan found something that fails it. |

By default, any problem a scan reports fails the job. To change which types of problem a scan checks for, set
`scan_types` in `perch.yaml`. To report a rule without failing the job, set `gate: false` on it. For more, see
[Gates](/rules/#gates).