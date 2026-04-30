# BitMine

High-performance Bitcoin & Ethereum private key hunting tool for secp256k1 elliptic curve puzzles — now with a real-time **Web UI dashboard**.

Post: https://bitcointalk.org/index.php?topic=5322040.0

Works for Bitcoin:
- address compress or uncompress
- hashes rmd160 compress or uncompress
- publickeys compress or uncompress

Works for Ethereum:
- address

---

## 🖥 Web UI Dashboard

BitMine ships with a browser-based dashboard to start, monitor, and manage hunts from any device.

**Features:**
- Live console output with color-coded log lines
- Real-time speed graph (auto-scales: Mkeys/s → Tkeys/s → Exakeys/s)
- Found keys table with export to JSON
- Full configuration panel (all CLI flags)
- Background process — keyhunt keeps running even if you close the browser

### Run the dashboard

```bash
cd frontend
npm install
node server.js
# Open http://localhost:3000
```

### Deploy to a server (one command)

```bash
git clone https://github.com/nahomtaboge21/keyhunt.updated.git /opt/bitmine
cd /opt/bitmine && bash deploy.sh
```

See [deploy.sh](deploy.sh) for full details.

---

## TL;DR — CLI Quick Start

Build and run against puzzle 66 (address mode):

```bash
make
./bitmine -m address -f tests/66.txt -b 66 -l compress -R -q -s 10
```

Add `-t numberThreads` for better speed.

Run against Puzzle 125 (bsgs mode):

```bash
./bitmine -m bsgs -f tests/125.txt -b 125 -q -s 10 -R
```

Add `-t numberThreads` and `-k factor` for better speed.

---

## Free Code

This code is free of charge, see the licence for more details. https://github.com/albertobsd/keyhunt/blob/main/LICENSE

Although the original project is a hobby for the original author, it still involves a considerable amount of work.
If you would like to support the original project, please consider donating at https://github.com/albertobsd/keyhunt#donations.

---

# Disclaimer

This tool was made as a generic tool for the Bitcoin Puzzles.
I recommend to everyone to stay in puzzles.

Several users requested support for ethereum and minikeys — it's included.
But again, I recommend only using this program for puzzles.

## For regular users

Please read the CHANGELOG.md to see the new changes.

---

# Download and Build

This program was made in a Linux environment.
If you are a Windows user, I strongly recommend using the WSL environment on Windows (available in the Microsoft Store).

Install on your system:

- git
- build-essential

For legacy version you also need:

- libssl-dev
- libgmp-dev

On Debian-based systems:

```bash
apt update && apt upgrade
apt install git build-essential libssl-dev libgmp-dev -y
```

Clone the repository:

```bash
git clone https://github.com/nahomtaboge21/keyhunt.updated.git
cd keyhunt.updated
```

Compile:

```bash
make
```

If you have problems compiling the `main` version, compile the `legacy` version:

```bash
make legacy
```

Show help:

```bash
./bitmine -h
```

## ¡Beta!

This version is still a **beta** version; there are a lot of things that can fail or be improved.
This version could also have some bugs — please report them.

---

# Modes

BitMine can work in different ways at different speeds.

Current available modes:
- address
- rmd160
- xpoint
- bsgs

## Experimental modes

- minikeys
- pub2rmd

## address mode

This is the most basic approach. Your text file needs to have a list of public addresses to search.

Example file `tests/1to32.txt`:

```
1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH
1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb
...
```

```bash
./bitmine -m address -f tests/1to32.txt -r 1:FFFFFFFF
```

Output:
```
[+] Version 0.2.230430 Satoshi Quest, developed by AlbertoBSD
[+] Mode address
...
Hit! Private Key: 1
pubkey: 0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798
Address 1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH
rmd160 751e76e8199196d454941c45d1b3a323f1433bd6
```

Test your luck against puzzle #66:

```bash
./bitmine -m address -f tests/66.txt -b 66 -l compress -R -q -s 10
```

### Vanity search

```bash
./bitmine -m vanity -l compress -R -b 256 -v 1Good1 -v 1MyKey
```

## rmd160 mode

```bash
./bitmine -m rmd160 -f tests/1to32.rmd -r 1:FFFFFFFF -l compress -s 5
```

Test puzzle #66:

```bash
./bitmine -m rmd160 -f tests/66.rmd -b 66 -l compress -R -q
```

## xpoint mode

Targets the X value of the public key. Faster than address/rmd160.

```bash
./bitmine -m xpoint -f tests/substracted40.txt -n 65536 -t 4 -b 40
./bitmine -m xpoint -f tests/120.txt -t 4 -b 125 -R -q
```

## Endomorphism

Enable with `-e` — checks 6 keys per computation for modes `address`, `rmd160`, `vanity`, `xpoint`.

## bsgs mode (Baby Step Giant Step)

BSGS searches a known public key range. The input file needs a list of public keys (compressed or uncompressed).

```bash
./bitmine -m bsgs -f tests/125.txt -b 125 -q -s 10 -R
```

With high K-factor (more RAM = more speed):

```bash
./bitmine -m bsgs -f tests/125.txt -b 125 -R -k 512 -q -t 8 -s 10 -S
```

### RAM vs K-factor guide

| RAM  | Recommended flags |
|------|-------------------|
| 2 GB | `-k 128` |
| 4 GB | `-k 256` |
| 8 GB | `-k 512` |
| 16 GB | `-k 1024` |
| 32 GB | `-k 2048` |
| 64 GB | `-n 0x100000000000 -k 4096` |

### Valid n and maximum k values

```
+------+----------------------+-------------+
| bits |  n in hexadecimal    | k max value |
+------+----------------------+-------------+
|   20 |             0x100000 | 1 (default) |
|   22 |             0x400000 | 2           |
|   24 |            0x1000000 | 4           |
|   26 |            0x4000000 | 8           |
|   28 |           0x10000000 | 16          |
|   30 |           0x40000000 | 32          |
|   32 |          0x100000000 | 64          |
|   34 |          0x400000000 | 128         |
|   36 |         0x1000000000 | 256         |
|   38 |         0x4000000000 | 512         |
|   40 |        0x10000000000 | 1024        |
|   42 |        0x40000000000 | 2048        |
|   44 |       0x100000000000 | 4096        |
+------+----------------------+-------------+
```

## minikeys mode

```bash
./bitmine -m minikeys -f tests/minikeys.txt -C SG64GZqySYwBm9KxE1wJ28 -n 0x10000
./bitmine -m minikeys -f tests/minikeys.txt -n 0x10000 -q -R
```

## Ethereum

```bash
./bitmine -c eth -f tests/1to32.eth -r 1:100000000 -M
```

---

## FAQ

- **Where are private keys saved?**  
  In `KEYFOUNDKEYFOUND.txt` in the current directory, and also tracked by the Web UI in `frontend/found_keys.json`.

- **Can I save the bloom filter to speed up restarts?**  
  Yes — use `-S`. Works for: `bsgs`, `address`, `rmd160`, `minikeys`, `xpoint`.

- **Is it available for Windows?**  
  It can be compiled with MinGW, but WSL with Ubuntu is strongly recommended.

---

## Thanks

This program was possible thanks to:
- IceLand
- kanhavishva
- XopMC
- WanderingPhilosopher
- Malboro Man
- NetSec
- Jean Luc Pons
- All the CryptoHunters group
- All users who tested, reported bugs, and requested improvements

## Donations (original author)

- BTC: 1Coffee1jV4gB5gaXfHgSHDz9xx9QSECVW
- ETH: 0x6222978c984C22d21b11b5b6b0Dd839C75821069
- DOGE: DKAG4g2HwVFCLzs7YWdgtcsK6v5jym1ErV
