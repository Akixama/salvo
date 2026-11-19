# Salvo

**A faster, front-running-proof copy of Solana, running as its own test chain.**

Try it: [salvo-net.vercel.app](https://salvo-net.vercel.app)

## What it is

Salvo is a blockchain that works like Solana. Solana apps and wallets work on it without changes. Two things make it different:

1. **It's much faster.** Solana makes a new block every 400 ms. Salvo makes one every **10 ms**, 40 times as often.
2. **Bots can't jump ahead of your trade.** You can send your trade locked. Nobody can see what's inside until its place in line is fixed, so no one can see it coming and trade in front of you.

## Why it matters

On most chains today, the computer that builds each block can see every trade waiting to go in. Bots use that to "sandwich" people: they spot your buy, buy just before you to push the price up, then sell to you at the higher price. You pay more, and they keep the difference. On Solana this has cost traders hundreds of millions of dollars.

Speed matters too. When blocks only come every 400 ms, your trade can sit waiting for the next one, and prices can move while it waits. With a block every 10 ms, there's always one about to land.

Salvo goes after both problems at once: blocks come 40 times as often, and your trade stays locked until its spot is fixed.

## How it works, in plain words

- **Lock:** your wallet locks your trade before sending it.
- **Take turns:** 24 block makers work at the same time, each starting 10 ms after the last, so a block is always about to land.
- **Vote:** validators vote on every block, and once most of them agree, it's accepted.
- **Line up:** all the blocks are put into one list, in an order everyone agrees on.
- **Unlock:** only after your trade's spot in that list is fixed do the validators unlock it. By then it's too late for anyone to jump ahead.
- **Run:** your trade runs on the same engine Solana uses.

It's built from a new research paper by Anza and a16z researchers, called Gatling. Salvo turns that paper into a working chain you can try.

## Numbers, measured live

| | Salvo |
|---|---|
| New block every | 10 ms |
| A block is final in | about 0.26 seconds |
| Your trade is done in | about 0.3 seconds |

Every number on the site is measured as it happens, not copied from a slide.

## What you can do on the site

- **Send:** get free test SOL and send a locked trade, then watch each step happen with its timing.
- **Net:** watch the chain live, block by block, as the 24 block makers take turns.
- **Mine:** look up any address's balance and history.
- **Fault Lab:** try to break it by switching validators off, slowing them down or cutting off a region, and see what happens.
- **Docs:** connect a Solana wallet, the Solana command-line tool or your own app.

## Who it's for

- **Traders** who are tired of getting sandwiched and want their trades to land fast.
- **Solana builders** who want a much faster chain without rewriting their apps.
- **Anyone curious** about where Solana's speed could go next. The Fault Lab lets you see how it holds up for yourself.

## Honest notes

- It's a **test network**. Test SOL is free and worth nothing.
- For now, the validators run on one computer, and the distances between cities (Frankfurt, London, New York, Tokyo, Singapore) are simulated.

## What's next

**Letting other people run validators.** Right now all the validators are run by Salvo. Next, anyone will be able to run one on their own computer:

- **First, a "follower" mode.** You run Salvo on your machine, and it checks every block and every result for itself. You don't have to trust the site's numbers; your own computer confirms them.
- **Then real validators.** You'll create your keys, ask to join, and your computer will start voting on blocks alongside the others.
- **A "Run a validator" page** on the site, with simple steps and a live list of every validator and where it is.

The more independent validators there are, the less anyone has to trust a single operator, and the closer Salvo gets to being a real, open network.

Feedback welcome: what would make you use this?
