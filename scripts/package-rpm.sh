#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')
count=$(git rev-list --count HEAD)
short=$(git rev-parse --short=12 HEAD)
# Preserve the source revision even when checkout is shallow (CI fetches history).
arch=$(uname -m)
top="$PWD/.build-home/rpmbuild"
mkdir -p "$top"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
cp "dist/rewindos-linux-$arch.tar.gz" "$top/SOURCES/"
rpmbuild -bb packaging/linux/rewindos.spec \
  --define "_topdir $top" \
  --define "app_version $version" \
  --define "commit_count $count" \
  --define "commit_short $short"
shopt -s nullglob
packages=("$top/RPMS/$arch/rewindos-$version-0.$count.git$short"*.rpm)
[[ ${#packages[@]} == 1 ]] || { printf 'Expected one RPM, found %s\n' "${#packages[@]}" >&2; exit 1; }
cp "${packages[0]}" dist/
package="dist/$(basename "${packages[0]}")"
[[ $(rpm -qp --qf '%{ARCH}' "$package") == "$arch" ]]
rpm -qp --requires "$package"
rpm -qpl "$package"
(cd dist && sha256sum "$(basename "$package")" > "$(basename "$package").sha256")
