---
title: Quick start
nav: Quick start
group: Getting started
order: 2
summary: Install Perch, choose a model endpoint, and run your first scan.
---

# Quick start

## Prerequisites

To use Perch, you need Node.js 22 or later and git. Perch scans the commit that is currently checked out, so you need to
run it inside a git repository.

## Install Perch

Install Perch globally with npm:

```sh
npm install -g @lakeday/perch
```

To run Perch without installing it, use `npx @lakeday/perch` in place of `perch`. For example, `npx @lakeday/perch scan`.

## Choose a model endpoint

Perch asks a model about your code. A scan goes to `PERCH_BASE_URL` if you set one, and otherwise to [OI]'s Decisions API,
where `gpt-6-luna` answers. Either credential works there: a ChatGPT subscription signed in with
`codex login`, or an `OPENAI_API_KEY`.

If the Decisions API refuses a run because the subscription window is spent or the account is out of credit, the scan reads
with elephant-1 on this machine instead and says so. mlx-decision serves it, downloads the model on first use, and runs on
Apple silicon. A server already running is used rather than replaced by a second one — one copy of the model holds several
gigabytes — and one is started only when no server is there. Install mlx-decision with `uv tool install mlx-decision`, or
set `PERCH_LOCAL_MODEL=off` to do without the fallback.

To point a scan at another endpoint, set `PERCH_BASE_URL` to it and `PERCH_API_KEY` to its key. To use TypeSafe's System One:

```sh
export PERCH_BASE_URL=https://api.typesafe.ai/v1/systemone
export PERCH_API_KEY='paste-your-TypeSafe-key-here'
```

Those lines belong in your shell profile, or in `~/.perch/config.toml` as `base_url` and `model`. For the other endpoints
and the model each one takes, see [Environment](/cli/#environment).

## Run your first scan

Navigate to the root of your repository and run `perch scan`:

```console
$ perch scan
inventory.py
  ID        Line  Severity  Type    Confidence  Problem             Method
  0d0e3f8a     5  P1 (0.8)  defect         88%  wrong_return_value  reserve
  225c1645    21  P1 (0.7)  defect         93%  wrong_order         release_expired

checkout.py
  ID        Line  Severity  Type    Confidence  Problem             Method
  bdc67421    10  P1 (0.9)  defect         82%  wrong_order         place_order
  ddc5c917    21  P1 (0.9)  defect         94%  wrong_return_value  can_fulfil
  4f8bf5dc    29  P1 (0.8)  defect         68%  bad_state_change    refund

cart.py
  ID        Line  Severity  Type    Confidence  Problem             Method
  287bfb9d     7  P1 (1.1)  defect         93%  off_by_one          subtotal
  44c8d48a    21  P1 (1.0)  defect         74%  inverted_condition  is_eligible_for_free_shipping
  80d6ebbb    28  P1 (1.3)  defect         91%  unhandled_null      cheapest

storage.py
  ID        Line  Severity  Type    Confidence  Problem        Method
  5a623390    10  P1 (1.0)  defect         68%  error_ignored  load_order

✖ 9 problems in 4 files, all failing
order-service at commit b412add: 15 methods, read 15
15 requests  17k tokens in / 3k out  $0.0065
```

Perch makes at least one request per method, so scanning a large repository can take hundreds of requests. To scan only
part of a repository, pass a directory, such as `perch scan src`. For other ways to narrow a scan, see
[Scanning your code](/scanning/).
