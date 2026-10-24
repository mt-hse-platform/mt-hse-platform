#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu server (Oracle Cloud): updates, Docker, firewall ports 80/443, git.
# Run as the normal user (ubuntu), not as root:   bash ops/setup-server.sh
set -euo pipefail

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get -y upgrade
sudo DEBIAN_FRONTEND=noninteractive apt-get -y install git curl unattended-upgrades iptables-persistent

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER"

# Oracle's Ubuntu images ship an iptables rule that rejects everything except SSH: open web ports at the top of the chain.
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
done
sudo netfilter-persistent save

echo "Done. Log out and back in once so the docker group applies, then run:  docker run --rm hello-world"
