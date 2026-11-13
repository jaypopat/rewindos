Name:           rewindos
Version:        %{app_version}
Release:        0.%{commit_count}.git%{commit_short}%{?dist}
Summary:        Local screen capture, OCR, and search
License:        AGPL-3.0-only
URL:            https://github.com/jaypopat/rewindos
Source0:        rewindos-linux-%{_arch}.tar.gz

# These are already-built release binaries. Keep ELF dependency generation on.
%global debug_package %{nil}
%global _build_id_links none

BuildRequires:  systemd-rpm-macros
Requires:       tesseract
Requires:       tesseract-langpack-eng
Requires:       libappindicator-gtk3
Requires:       pipewire
Requires:       xdg-desktop-portal

%description
RewindOS records and searches local screen history. This package includes the
Tauri desktop app and capture daemon, with Tesseract as the default OCR engine.
Installing it does not enable capture, autostart, or the daemon service.

%prep
%setup -q -n rewindos-linux-%{_arch}

%build
# Native binaries were compiled and tested by scripts/build-linux.sh.

%install
install -Dpm755 rewindos %{buildroot}%{_bindir}/rewindos
install -Dpm755 rewindos-daemon %{buildroot}%{_bindir}/rewindos-daemon
install -Dpm644 rewindos-daemon.service %{buildroot}%{_userunitdir}/rewindos-daemon.service
sed -i 's|^ExecStart=.*|ExecStart=/usr/bin/rewindos-daemon|' %{buildroot}%{_userunitdir}/rewindos-daemon.service
install -Dpm644 rewindos.desktop %{buildroot}%{_datadir}/applications/io.github.jaypopat.rewindos.desktop
sed -i 's|^Exec=.*|Exec=/usr/bin/rewindos|' %{buildroot}%{_datadir}/applications/io.github.jaypopat.rewindos.desktop
install -Dpm644 com.rewindos.Daemon.desktop %{buildroot}%{_datadir}/applications/com.rewindos.Daemon.desktop
sed -i 's|^Exec=.*|Exec=/usr/bin/rewindos-daemon|' %{buildroot}%{_datadir}/applications/com.rewindos.Daemon.desktop
install -Dpm644 paddleocr_worker.py %{buildroot}/usr/lib/rewindos/paddleocr_worker.py
install -Dpm644 icons/32x32.png %{buildroot}%{_datadir}/icons/hicolor/32x32/apps/io.github.jaypopat.rewindos.png
install -Dpm644 icons/128x128.png %{buildroot}%{_datadir}/icons/hicolor/128x128/apps/io.github.jaypopat.rewindos.png
install -Dpm644 icons/128x128@2x.png %{buildroot}%{_datadir}/icons/hicolor/256x256/apps/io.github.jaypopat.rewindos.png
install -Dpm644 icons/icon.png %{buildroot}%{_datadir}/icons/hicolor/512x512/apps/io.github.jaypopat.rewindos.png

%files
%license LICENSE
%doc BUILD-INFO.txt
%{_bindir}/rewindos
%{_bindir}/rewindos-daemon
%{_userunitdir}/rewindos-daemon.service
%{_datadir}/applications/io.github.jaypopat.rewindos.desktop
%{_datadir}/applications/com.rewindos.Daemon.desktop
/usr/lib/rewindos/
%{_datadir}/icons/hicolor/*/apps/io.github.jaypopat.rewindos.png

%changelog
* Fri Nov 13 2026 Walerie <okwalerie@users.noreply.github.com>
- Package native ARM64 binaries with Tesseract and opt-in user service.
