# signalk-ruuvitag-bluez

A SignalK plugin that publishes [RuuviTag](https://ruuvi.com/) environmental
data — temperature, humidity, pressure, acceleration, RSSI, battery
voltage — by talking to **BlueZ over DBus** instead of opening raw HCI
sockets.

It is a drop-in alternative to
[`signalk-ruuvitag-plugin`](https://github.com/vokkim/signalk-ruuvitag-plugin)
(by Mikko Vesikkala / @vokkim) for the same hardware, with the same
SignalK paths, designed to coexist with other BlueZ users such as
[`signalk-victron-ble`](https://github.com/sbender9/signalk-victron-ble).

## Why a different plugin?

The original plugin uses `node-ruuvitag`, which uses `noble`, which opens
a raw HCI socket. That has three painful consequences on a typical
boat-Pi:

- **Conflicts with other BlueZ clients** — only one process can own the
  HCI socket. If `signalk-victron-ble` is running (it uses BlueZ via
  DBus), you can't also run the original Ruuvi plugin and vice-versa.
- **Privileged Docker** — the SignalK container needs
  `privileged: true`, `network_mode: host`, *and* `setcap
  cap_net_raw,cap_net_admin+eip` baked into the image.
- **Fragility** — adapter-state desync between BlueZ and noble shows up
  as scans that silently stop working after a kernel/BlueZ update.

This plugin does none of that. BlueZ is the single owner of the radio,
the plugin is one of many DBus clients reading advertisement data, and
the only Docker requirement is mounting `/var/run/dbus` into the SignalK
container.

## Requirements

- SignalK Node Server
- Linux with BlueZ ≥ 5.50 (`bluetoothctl --version`)
- `bluetoothd` running on the host
- Node.js 20 or newer

## Install

From the SignalK Appstore (once published), or manually:

```
cd ~/.signalk/node_modules
git clone https://github.com/<your-fork>/signalk-ruuvitag-bluez.git
cd signalk-ruuvitag-bluez && npm install
# restart SignalK
```

## Configure

Open the SignalK admin UI → **Server → Plugin Config → RuuviTag Plugin (BlueZ)**.

The list is populated dynamically: each tag appears in the config only
*after* its first advertisement has been received. For each tag, set:

- **Enabled** — publish SignalK deltas for this tag
- **Source name** — used as `$source` label and in the
  `electrical.batteries.<name>.voltage` path. Letters and digits, 1–12
  chars.
- **Location** — used as `environment.<location>.*`. Dot-separated, e.g.
  `inside.salon` or `outside.cockpit`. (If `location` starts with
  `outside.`, humidity is published as `humidity` rather than
  `relativeHumidity`, matching the SignalK convention for outdoor
  sensors.)

## SignalK paths emitted

Per tag, with `<location>` and `<name>` from the config above:

| Path | Unit | Source |
| --- | --- | --- |
| `environment.<location>.temperature` | K | RAWv2 / RAWv1 |
| `environment.<location>.relativeHumidity` (or `humidity` if outside) | ratio (0–1) | RAWv2 / RAWv1 |
| `environment.<location>.pressure` | Pa | RAWv2 / RAWv1 |
| `environment.<location>.accelerationX/Y/Z` | g | RAWv2 / RAWv1 |
| `environment.<location>.rssi` | dBm | BlueZ |
| `electrical.batteries.<name>.voltage` | V | RAWv2 / RAWv1 |

A path is omitted if the tag reported the field as "not measured"
(per-field `0xFFFF` / `0x8000` sentinels in the Ruuvi spec).

**SignalK metadata** (units + descriptions) is emitted with the first
delta for each tag, so the admin UI can display unit conversions
(`K → °F`, `Pa → inHg`, …) and downstream consumers like InfluxDB
get correctly-labelled series even when the location string isn't a
SignalK standard one. Metadata is re-emitted whenever the plugin is
restarted (which SignalK does automatically when you save plugin
config).

## Migration from signalk-ruuvitag-plugin

Tag IDs are intentionally compatible: lowercase MAC without colons
(e.g. `c2646bf3e6eb`). Copy the `tags` block of your existing
`plugin-config-data` over and just rename the plugin id from `ruuvitag`
to `signalk-ruuvitag-bluez`. Paths and `$source` labels keep the same
shape; the source label changes from `ruuvitag.<name>` to
`signalk-ruuvitag-bluez.<name>`, so rules / dashboards filtering on
`$source` need that one rename.

You can run both plugins side-by-side during the cutover (BlueZ-DBus
and HCI-via-noble can in fact coexist on a host where the original
already works, though that's the situation we're trying to leave).
For a clean cutover, disable the old plugin first.

## Docker

The reason this plugin exists. Add to your SignalK container:

```yaml
services:
  signalk:
    # ...your existing config...
    volumes:
      - /var/run/dbus:/var/run/dbus    # required: DBus socket
    # NOT NEEDED with this plugin:
    # privileged: true
    # network_mode: host
    # cap_add: [NET_ADMIN]
```

Why the DBus mount alone is enough: Docker containers run as **root**
by default, and DBus identifies the caller by host-side UID via
`SO_PEERCRED` on the socket. BlueZ's default DBus policy
(`/etc/dbus-1/system.d/bluetooth.conf` on Debian/Raspbian) allows
root to call all `org.bluez` methods. No polkit rule, no group
membership, no capabilities.

If you run the SignalK container as a non-root user, the in-container
UID needs to either match a host user that's in the `bluetooth` group,
or you need a custom DBus policy granting that UID. For most boat-Pi
deployments (single-user, root in container), the mount-only setup is
the right answer.

## Coexistence

`signalk-victron-ble` and this plugin running on the same Pi at the
same time is the supported configuration — both are DBus clients,
BlueZ delivers each advertisement to every subscribed client, and there
is no contention.

`bluetoothctl scan on` from the same shell also works and is a useful
debugging move.

## Tests

```
npm test
```

Runs `decoder.test.js` against the canonical Ruuvi spec test vector,
several real captured frames, an all-sentinels frame for invalid-value
handling, and format 3 (RAWv1) vectors.

## Credit

Forked from
[`vokkim/signalk-ruuvitag-plugin`](https://github.com/vokkim/signalk-ruuvitag-plugin)
by Mikko Vesikkala (MIT). The schema shape, config conventions, SignalK
path layout, and unit conversions are all directly from that project —
this fork swaps the `node-ruuvitag` (noble/HCI) backend for BlueZ-via-DBus
using [`dbus-next`](https://github.com/dbusjs/node-dbus-next), and adds
in-tree Ruuvi RAWv1 / RAWv2 decoders.

## License

MIT (see `LICENSE`). Original `signalk-ruuvitag-plugin` is also MIT.
