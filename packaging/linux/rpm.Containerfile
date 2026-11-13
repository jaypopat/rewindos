FROM registry.fedoraproject.org/fedora:44
RUN dnf -y install rpm-build systemd-rpm-macros python3 python3-pillow dejavu-sans-fonts \
    xorg-x11-server-Xvfb xorg-x11-xauth dbus-daemon git \
    && dnf clean all
WORKDIR /work
CMD ["bash", "scripts/package-rpm.sh"]
