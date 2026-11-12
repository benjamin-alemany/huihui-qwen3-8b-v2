The vendor package versions and SHA256 values are frozen in packages.lock.json.
Ubuntu dependencies and linux-headers-$(uname -r) depend on the eventual VM image.
The trusted bootstrap resolves these from authenticated Ubuntu APT metadata,
records their exact package/version/SHA256 before any package installation,
downloads without installing, verifies every .deb against that resolved lock,
then installs with --no-download. No unreviewed vendor package/version is allowed.
This target lock is evidence about the future selected VM, not a lock fabricated
from a different kernel. Missing headers, unresolved DKMS or changed vendor bytes
are fatal. No older driver, unsigned repository, or unversioned installer fallback.
