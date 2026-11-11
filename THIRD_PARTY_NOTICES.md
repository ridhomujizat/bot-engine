# Third-party notices

The following third-party code is included in this repository.

| Component | Location | Version | License |
|---|---|---|---|
| lodash | `internal/usercode/js/lodash/` | 4.17.21 | MIT (`LICENSE` in the directory) |
| moment | `internal/usercode/js/moment/` | 2.29.4 | MIT (`LICENSE` in the directory) |
| qs (lib/ only) | `internal/usercode/js/qs/` | 6.13.0 | BSD-3-Clause (`LICENSE` in the directory) |
| side-channel (shim) | `internal/usercode/js/side-channel/` | n/a, written for this project as a replacement for the npm package | see the root `LICENSE` |
| Mock Service Worker | `ui/public/mockServiceWorker.js` | 3.0.4 | MIT (generated file, used only with `VITE_MOCK=1`) |

The license texts shipped with the vendored packages are kept unchanged.

Go and npm dependencies are listed in `go.mod` and `ui/pnpm-lock.yaml` and carry their own licenses.
