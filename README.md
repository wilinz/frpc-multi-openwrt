# frpc-openwrt

frp 客户端的 OpenWrt 包，支持多实例。二进制直接取自 [fatedier/frp](https://github.com/fatedier/frp) 官方 release。

| 包 | 内容 |
|----|------|
| `frpc` | `/usr/bin/frpc` + procd 多实例服务 + UCI 配置 |
| `luci-app-frpc` | LuCI 界面(服务 → frp 客户端)：只有启用开关和配置文件编辑 |

## 构建

```sh
./build.sh                                   # x86_64
ARCH=aarch64_cortex-a53 ./build.sh
ARCH=mipsel_24kc UPX=1 ./build.sh            # 小闪存机型可 upx 压缩
FRP_VERSION=0.71.0 ./build.sh                # 指定 frp 版本
```

产物在 `out/`，下载的 release 缓存在 `dl/`。

## 配置

每个 `instance` 段是一个 frpc 进程，配置文件固定为 `/etc/frpc/<段名>.toml`：

```
config instance 'main'
	option enabled '1'
config instance 'office'
	option enabled '1'
```

```sh
/etc/init.d/frpc reload     # 只重启配置文件或开关有变化的实例
logread -e frpc
```

- LuCI 保存时直接写配置文件并 reload；UCI 开关变化靠 procd 触发器 reload。
- 配置文件缺失或为空的实例会被跳过。
- 删除实例不会删除它的 `.toml`，同名重建会沿用。
- 与官方软件源的 `frpc` / `luci-app-frpc` 同名且配置格式不同，二者不能共存。
