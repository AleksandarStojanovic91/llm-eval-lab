# Live cassettes

Empty until the owner records a real run with an API key and an approved budget:

```bash
npm run eval -- --record --config configs/live.yaml --budget-usd 15
```

Recordings here are real Claude API responses (`"recordedFrom": "live"`). Once committed, `npm run eval --
--replay --config configs/live.yaml` replays them offline. Review a recording before committing it: responses
can quote tool results verbatim, including the injected text in the fixture book descriptions.
