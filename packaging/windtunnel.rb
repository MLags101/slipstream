# Homebrew cask for WindTunnel.
#
# To publish: create a public repo named `homebrew-windtunnel` under your
# GitHub account, put this file at Casks/windtunnel.rb, and update the
# version/sha256 on each release (sha256 is printed by the release workflow).
# Users then install with:
#   brew install --cask --no-quarantine OwenTWebb/windtunnel/windtunnel
cask "windtunnel" do
  version "0.1.0"
  sha256 "REPLACE_WITH_SHA256_FROM_RELEASE_WORKFLOW"

  url "https://github.com/OwenTWebb/windtunnel/releases/download/v#{version}/WindTunnel-v#{version}-macos-arm64.zip"
  name "WindTunnel"
  desc "Virtual wind tunnel: drop an STL, get OpenFOAM CFD analysis"
  homepage "https://github.com/OwenTWebb/windtunnel"

  depends_on cask: "gerlero/openfoam/openfoam"
  depends_on arch: :arm64

  app "WindTunnel.app"

  zap trash: "~/.windtunnel"

  caveats <<~EOS
    WindTunnel is unsigned (free, open-source project). If you installed
    without --no-quarantine, allow it once via System Settings ->
    Privacy & Security -> "Open Anyway".
  EOS
end
