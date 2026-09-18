#!/usr/bin/env bash
# 构建 frpc + luci-app-frpc 两个 ipk (照 rioadv-openwrt/build.sh)
# frpc 不自己编译, 直接取 fatedier/frp 官方 release 的静态二进制
# 依赖: curl, tar(ustar); UPX=1 时需 upx
#
# 可用环境变量:
#   ARCH         opkg 架构名             (默认 x86_64)
#   FRP_VERSION  frp 版本, 也是 frpc 包版本 (默认取自 pkg/frpc/CONTROL/control)
#   FRP_ARCH     frp release 的架构后缀   (默认按 ARCH 推断, 如 amd64/arm64/arm_hf/mipsle)
#   VERSION      luci-app-frpc 版本号     (默认取自其 CONTROL/control)
#   UPX          1=用 upx 压缩 frpc, 小闪存机型用 (默认 0)
#   BUILD_ENGINE 1/0  是否打包 frpc 包 (默认 1)
#   BUILD_LUCI   1/0  是否打包 LuCI 包(架构无关) (默认 1)
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
OUT="$ROOT/out"
DL="$ROOT/dl"
ARCH="${ARCH:-x86_64}"
FRP_VERSION="${FRP_VERSION:-}"
FRP_ARCH="${FRP_ARCH:-}"
VERSION="${VERSION:-}"
UPX="${UPX:-0}"
BUILD_ENGINE="${BUILD_ENGINE:-1}"
BUILD_LUCI="${BUILD_LUCI:-1}"
export COPYFILE_DISABLE=1   # 禁 macOS AppleDouble (._*)

sedi() {  # <expr> <file>  (GNU/BSD sed -i 通用写法)
	sed -i.bak "$1" "$2" && rm -f "$2.bak"
}

CONTROL=pkg/frpc/CONTROL/control
[ -n "$FRP_VERSION" ] && sedi "s/^Version:.*/Version: ${FRP_VERSION#v}/" "$CONTROL"
FRP_VERSION="$(awk -F': ' '/^Version:/{print $2}' "$CONTROL")"
sedi "s/^Architecture:.*/Architecture: $ARCH/" "$CONTROL"
[ -n "$VERSION" ] && sedi "s/^Version:.*/Version: $VERSION/" pkg/luci-app-frpc/CONTROL/control

# opkg 架构名 -> frp release 后缀; arm 带硬浮点(vfp/neon)的用 GOARM=7 的 arm_hf, 否则 GOARM=5
if [ -z "$FRP_ARCH" ]; then
	case "$ARCH" in
		x86_64)             FRP_ARCH=amd64 ;;
		aarch64_*)          FRP_ARCH=arm64 ;;
		arm_*vfp*|arm_*neon*) FRP_ARCH=arm_hf ;;
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
	mkdir -p pkg/frpc/data/usr/bin
	tar -xzf "$DL/$name.tar.gz" -O "$name/frpc" > pkg/frpc/data/usr/bin/frpc
	chmod 0755 pkg/frpc/data/usr/bin/frpc pkg/frpc/data/etc/init.d/frpc
	chmod 0600 pkg/frpc/data/etc/frpc/main.toml   # 含 token
	if [ "$UPX" = "1" ]; then
		upx --lzma -q pkg/frpc/data/usr/bin/frpc
	fi
	echo "==> 打包 frpc"
	build_ipk pkg/frpc "$ARCH"
fi

if [ "$BUILD_LUCI" = "1" ]; then
	echo "==> 打包 LuCI (all)"
	build_ipk pkg/luci-app-frpc all
fi

echo "==> 完成"
ls -la "$OUT"
