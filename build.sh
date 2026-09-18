#!/usr/bin/env bash
# 构建 frpc-multi + luci-app-frpc-multi 两个 ipk (照 rioadv-openwrt/build.sh)
# frpc 不自己编译, 直接取 fatedier/frp 官方 release 的静态二进制
# 依赖: curl, tar(ustar), cc/make(没有 po2lmo 时自动编一份); UPX=1 时需 upx
#
# 可用环境变量:
#   ARCH         opkg 架构名             (默认 x86_64)
#   FRP_VERSION  打包的 frp 版本                (默认 0.71.0)
#   FRP_ARCH     frp release 的架构后缀   (默认按 ARCH 推断, 如 amd64/arm64/arm_hf/mipsle)
#   VERSION      两个包的版本号, CI 用 tag 覆盖 (默认取自 CONTROL/control)
#   UPX          1=用 upx 压缩 frpc, 小闪存机型用 (默认 0)
#   BUILD_ENGINE 1/0  是否打包 frpc-multi 包 (默认 1)
#   BUILD_LUCI   1/0  是否打包 LuCI 包(架构无关) (默认 1)
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
OUT="$ROOT/out"
DL="$ROOT/dl"
ARCH="${ARCH:-x86_64}"
FRP_VERSION="${FRP_VERSION:-0.71.0}"
FRP_VERSION="${FRP_VERSION#v}"
FRP_ARCH="${FRP_ARCH:-}"
VERSION="${VERSION:-}"
UPX="${UPX:-0}"
BUILD_ENGINE="${BUILD_ENGINE:-1}"
BUILD_LUCI="${BUILD_LUCI:-1}"
export COPYFILE_DISABLE=1   # 禁 macOS AppleDouble (._*)

sedi() {  # <expr> <file>  (GNU/BSD sed -i 通用写法)
	sed -i.bak "$1" "$2" && rm -f "$2.bak"
}

# 包版本跟随本项目(tag), 与 frp 版本分开: 只改脚本不升 frp 时 opkg 也能升级
CONTROL=pkg/frpc-multi/CONTROL/control
if [ -n "$VERSION" ]; then
	for c in "$CONTROL" pkg/luci-app-frpc-multi/CONTROL/control; do
		sedi "s/^Version:.*/Version: $VERSION/" "$c"
	done
fi
sedi "s/^Architecture:.*/Architecture: $ARCH/" "$CONTROL"
sedi "s/^Description:.*/Description: frp client $FRP_VERSION, runs multiple instances with one config file each/" "$CONTROL"

# opkg 架构名 -> frp release 后缀。frp 的 arm_hf 是 GOARM=7(ARMv7 + VFPv3), 只给带浮点的
# cortex-a; 其余 arm(含 arm1176jzf-s_vfp 这类 ARMv6)用 GOARM=5 的 arm。frp 不出 32 位 x86。
if [ -z "$FRP_ARCH" ]; then
	case "$ARCH" in
		x86_64)             FRP_ARCH=amd64 ;;
		aarch64_*)          FRP_ARCH=arm64 ;;
		arm_cortex-a*_*vfp*|arm_cortex-a*_*neon*) FRP_ARCH=arm_hf ;;
		arm_*)              FRP_ARCH=arm ;;
		mipsel_*)           FRP_ARCH=mipsle ;;
		mips_*)             FRP_ARCH=mips ;;
		mips64el_*)         FRP_ARCH=mips64le ;;
		mips64_*)           FRP_ARCH=mips64 ;;
		riscv64_*)          FRP_ARCH=riscv64 ;;
		loongarch64_*)      FRP_ARCH=loong64 ;;
		*) echo "不认识的 ARCH=$ARCH, 请手动指定 FRP_ARCH" >&2; exit 1 ;;
	esac
fi

# tar 参数: GNU(Linux CI) 与 BSD(macOS) 语法不同, 分别处理; 统一 ustar + root 属主
if tar --version 2>/dev/null | grep -qi "gnu"; then
	TARFMT=(--format=ustar --owner=0 --group=0 --numeric-owner)
else
	TARFMT=(--format ustar --uid 0 --gid 0 --numeric-owner)
fi

# ustar 格式 + root 属主, 避免 opkg 读不了 pax 扩展头
tar_ustar() {  # <src_dir> <out.tar.gz>
	( cd "$1" && tar "${TARFMT[@]}" -czf "$2" ./* )
}

build_ipk() {  # <pkgdir> <arch>
	local pkgdir="$1" arch="$2"
	local name ver tmp ipk
	name="$(awk -F': ' '/^Package:/{print $2}' "$pkgdir/CONTROL/control")"
	ver="$(awk -F': ' '/^Version:/{print $2}' "$pkgdir/CONTROL/control")"
	tmp="$(mktemp -d)"

	printf '2.0\n' > "$tmp/debian-binary"
	chmod 0644 "$pkgdir/CONTROL/control"
	[ -f "$pkgdir/CONTROL/conffiles" ] && chmod 0644 "$pkgdir/CONTROL/conffiles"
	for s in preinst postinst prerm postrm; do
		[ -f "$pkgdir/CONTROL/$s" ] && chmod 0755 "$pkgdir/CONTROL/$s"
	done
	tar_ustar "$pkgdir/CONTROL" "$tmp/control.tar.gz"
	tar_ustar "$pkgdir/data"    "$tmp/data.tar.gz"

	mkdir -p "$OUT"
	ipk="$OUT/${name}_${ver}_${arch}.ipk"
	rm -f "$ipk"
	# OpenWrt 的 .ipk = 三个成员的 gzip tar (opkg-utils ipkg-build 的产物), 不是 ar!
	( cd "$tmp" && tar "${TARFMT[@]}" -czf "$ipk" ./debian-binary ./control.tar.gz ./data.tar.gz )
	rm -rf "$tmp"
	echo "    -> $ipk"
}

if [ "$BUILD_ENGINE" = "1" ]; then
	name="frp_${FRP_VERSION}_linux_${FRP_ARCH}"
	echo "==> 下载 $name (arch=$ARCH)"
	mkdir -p "$DL"
	if [ ! -s "$DL/$name.tar.gz" ]; then
		curl -fL --retry 3 -o "$DL/$name.tar.gz.part" \
			"https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/$name.tar.gz"
		mv "$DL/$name.tar.gz.part" "$DL/$name.tar.gz"
	fi
	# 不放 /usr/bin, 免得与官方 frpc 包的二进制冲突
	P=pkg/frpc-multi/data
	mkdir -p $P/usr/libexec/frpc-multi
	tar -xzf "$DL/$name.tar.gz" -O "$name/frpc" > $P/usr/libexec/frpc-multi/frpc
	chmod 0755 $P/usr/libexec/frpc-multi/frpc $P/usr/libexec/frpc-multi/ctl $P/etc/init.d/frpc-multi
	chmod 0644 $P/usr/share/frpc-multi/frpc.toml.example
	if [ "$UPX" = "1" ]; then
		upx --lzma -q $P/usr/libexec/frpc-multi/frpc
	fi
	echo "==> 打包 frpc-multi"
	build_ipk pkg/frpc-multi "$ARCH"
fi

# LuCI 翻译: po/<语言>/*.po -> usr/lib/lua/luci/i18n/<域>.<LuCI 语言码>.lmo
# 目录名用 LuCI 源码的写法(zh_Hans), 装到路由器上的文件名用别名(zh-cn), 同 luci.mk 的 LUCI_LC_ALIAS
lc_alias() {
	case "$1" in
		zh_Hans) echo zh-cn ;;
		zh_Hant) echo zh-tw ;;
		*) echo "$1" ;;
	esac
}

build_i18n() {
	local po2lmo i18n po lang
	po2lmo="$(command -v po2lmo || true)"
	if [ -z "$po2lmo" ]; then
		# LuCI 自带的 po2lmo 要 lemon 生成代码, 用拆出来的独立版(与 LuCI master 输出格式一致)
		po2lmo="$DL/po2lmo/src/po2lmo"
		if [ ! -x "$po2lmo" ]; then
			rm -rf "$DL/po2lmo"
			git clone -q --depth 1 https://github.com/openwrt-dev/po2lmo.git "$DL/po2lmo"
			# 自带的 lemon 是老代码, 编译警告很多, 只在失败时报错
			make -s -C "$DL/po2lmo" >/dev/null 2>&1 || { echo "po2lmo 编译失败" >&2; exit 1; }
		fi
	fi
	i18n=pkg/luci-app-frpc-multi/data/usr/lib/lua/luci/i18n
	rm -rf "$i18n" && mkdir -p "$i18n"
	for po in po/*/*.po; do
		lang="$(basename "$(dirname "$po")")"
		"$po2lmo" "$po" "$i18n/$(basename "$po" .po).$(lc_alias "$lang").lmo"
	done
	chmod 0644 "$i18n"/*.lmo
}

if [ "$BUILD_LUCI" = "1" ]; then
	echo "==> 编译翻译"
	mkdir -p "$DL"
	build_i18n
	echo "==> 打包 LuCI (all)"
	build_ipk pkg/luci-app-frpc-multi all
fi

echo "==> 完成"
ls -la "$OUT"
