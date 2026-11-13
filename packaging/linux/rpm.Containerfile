FROM registry.fedoraproject.org/fedora:44
RUN dnf -y install rpm-build systemd-rpm-macros python3 python3-pillow dejavu-sans-fonts \
    xorg-x11-server-Xvfb xorg-x11-xauth dbus-daemon git \
    && dnf clean all
ARG BUILD_UID=1000
ARG BUILD_GID=1000
COPY packaging/linux/create-build-user.sh /opt/create-build-user.sh
RUN bash /opt/create-build-user.sh "$BUILD_UID" "$BUILD_GID"
WORKDIR /work
CMD ["bash", "scripts/package-rpm.sh"]
