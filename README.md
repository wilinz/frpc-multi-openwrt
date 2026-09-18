# frpc-multi

English | [简体中文](README.zh-CN.md)

> An OpenWrt package for the [frp](https://github.com/fatedier/frp) client that **runs multiple frpc instances under one service**, with a minimal LuCI interface.

![LuCI interface](docs/screenshot.webp)

Each instance is a separate frpc process with its own TOML config file, and can be enabled, restarted, renamed and inspected on its own.
The frpc binary is taken as-is from the official frp release; nothing is compiled.

Package, service and config paths are all named `frpc-multi`, so it does not conflict with the official `frpc` / `luci-app-frpc` packages and can be installed alongside them.

## Why

- The official `frpc` package has a single config. Connecting to several frps servers, or keeping tunnels separate so that one failing does not take down the others, is awkward.
- The official LuCI app turns frpc options into form fields one by one and lags behind new frp options. Here you edit the native TOML directly, so anything frp supports can be used.

## Packages

| Package | Contents |
|---------|----------|
| `frpc-multi` | `/usr/libexec/frpc-multi/frpc` (official binary) + procd multi-instance service `/etc/init.d/frpc-multi` + UCI config + rename script |
| `luci-app-frpc-multi` | LuCI interface (Services → FrpcMulti), English UI with Simplified Chinese translation |

```
pkg/frpc-multi/           service package (CONTROL + data install tree)
pkg/luci-app-frpc-multi/  LuCI package
po/zh_Hans/               LuCI Chinese translation
build.sh                  downloads the frp release, compiles translations, builds both .ipk (no OpenWrt SDK needed)
```

## Build

Requires curl and tar. If `po2lmo` is not installed, [openwrt-dev/po2lmo](https://github.com/openwrt-dev/po2lmo) is fetched and built automatically (needs cc/make).

```sh
./build.sh                                   # x86_64
ARCH=aarch64_cortex-a53 ./build.sh
ARCH=arm_cortex-a7_neon-vfpv4 ./build.sh     # ARM with hardware float uses frp's arm_hf build
ARCH=mipsel_24kc UPX=1 ./build.sh            # compress with upx for small flash (frpc is about 16 MB)
FRP_VERSION=0.71.0 ./build.sh                # pick the frp version (default 0.71.0)
VERSION=1.2.0 ./build.sh                     # package version of both .ipk, CI sets it from the tag
```

`ARCH` is mapped to frp's release architecture automatically; set `FRP_ARCH=` if it is not recognized.
Packages are written to `out/`, downloaded releases are cached in `dl/`.

## Install and configure

```sh
opkg install frpc-multi_*_<arch>.ipk luci-app-frpc-multi_*_all.ipk
```

A disabled example instance `main` is installed. Fill in its config in LuCI and enable it, or edit the files directly:
each `instance` section is one instance, and its config file is always `/etc/frpc-multi/<name>.toml`.

```
# /etc/config/frpc-multi
config instance 'office'
	option enabled '1'
config instance 'home'
	option enabled '1'
```

```sh
/etc/init.d/frpc-multi reload                   # restart only instances whose config or switch changed
/etc/init.d/frpc-multi restart office           # restart a single instance
/usr/libexec/frpc-multi/rename office work      # rename, the config file is renamed too
logread -e '^frpc-office\['                     # logs of a single instance
```

Instance names may only contain letters, digits and underscores. An instance whose config file is missing or empty is skipped, with a warning in its log.

## LuCI

- Each instance collapses to one row showing its status, with Restart and Delete buttons; expand it to rename, toggle, edit the config file and view logs.
- Saving writes the config file and reloads the service; only instances that changed are restarted.
- Renaming takes effect immediately. It is refused while there are unapplied changes, so they do not point at the old name.
- The log panel supports level filter, search, follow, line wrap, copy and download, showing up to the last 500 lines.
- Deleting an instance keeps its `.toml`; recreating an instance with the same name reuses it.
- The UI is English by default and switches to Chinese when the LuCI language is Chinese, or Auto with a Chinese browser.

## Behavior

- Each instance is started through the symlink `/var/run/frpc-multi/frpc-<name>`, so its syslog tag is `frpc-<name>[pid]` and logs can be told apart per instance.
- Processes are supervised by procd and respawned when they exit. frp exits on login failure by default; add `loginFailExit = false` to keep retrying.
- frpc logs with ANSI colors by default. Adding `log.disablePrintColor = true` is recommended; without it LuCI strips the color codes anyway.

## Translation

UI strings are written in English and wrapped in `_()`; Chinese goes into `po/zh_Hans/frpc-multi.po`.
The build compiles it into `/usr/lib/lua/luci/i18n/frpc-multi.zh-cn.lmo` inside the LuCI package.
