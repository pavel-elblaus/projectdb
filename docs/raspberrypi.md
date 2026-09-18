# LIMS-USB on Raspberry Pi

This guide describes the LIMS-USB device installer developed for a separate commercial LIMS product built on ProjectDB. The device receives files from an instrument through a virtual USB drive and sends their data to the configured LIMS server.

You need a registered device and connection details from your LIMS administrator. This installer prepares the device; it does not install the LIMS server.

## Hardware and operating system

Use the following hardware and operating system:

| Item | Configuration |
| --- | --- |
| Target board | Raspberry Pi Zero 2 W |
| Card preparation stand | Raspberry Pi 4 Model B Rev 1.5 |
| Operating system | Raspberry Pi OS Lite, Bookworm, 64-bit |
| Connection to the instrument | USB data connection through the board's USB OTG port |
| Network | A connection that can reach the LIMS server and download installation packages |
| Status indicator | RGB indicator: GPIO 22 — red, GPIO 17 — green, GPIO 27 — blue. GPIO is used only to indicate device status. |

## Prepare the memory card

1. Open Raspberry Pi Imager and select Raspberry Pi Zero 2 W, the Bookworm 64-bit Lite image and the target memory card.
2. Set the user account, network and regional settings. Enable SSH to connect to the device.
3. Write the image and wait for verification to complete. Writing the image erases the selected card.
4. Insert the card into the device or preparation stand and start it.
5. Sign in over SSH. Have the LIMS server address, device name and device access password ready.

## Download and run

Open a root shell on the Raspberry Pi:

```bash
sudo -i
```

Download the device installer:

```bash
curl -fLO https://raw.githubusercontent.com/pavel-elblaus/projectdb/master/dist/pdb-install-raspberrypi.sh
```

After the download succeeds, start it:

```bash
bash pdb-install-raspberrypi.sh
```

**If you see `curl: command not found` when downloading:** install curl with the command below, then repeat the download and launch:

```bash
apt-get update && apt-get install -y curl
```

### Installation questions

| Question | What to enter |
| --- | --- |
| LIMS server address | A server address such as `https://lims.example.org` or `http://192.168.1.10`. If you enter a domain without a scheme, setup adds `https://`. |
| Device name | The name registered for this device in your LIMS. The suggested name is `LIMS-USB`; change it to match your registration. |
| Device access password | The access password assigned to the device. Input is visible so you can check it. There is no default password. |
| Start installation? | Review the server and device name, then press Enter or enter `y` to continue. Enter `n` to cancel. |

Use up to 100 Latin letters, numbers, dots, underscores or hyphens for the device name, starting with a letter or number. The device password is for the LIMS connection, not your SSH account or a PostgreSQL account.

## Installation progress and completion

Progress display and resuming after **Ctrl+C** are covered in the “Progress, logs and retrying” section of the [main guide](../README.md). Device logs are saved as `~/.projectdb/log/projectdb-pi-install.*.log`; the exact path appears at startup.

After a successful installation, the device **reboots automatically**. The LIMS-USB service starts at each boot.

## Check the device after reboot

On a Raspberry Pi 4 preparation stand, check that the service starts and connects to the LIMS. To test file transfer, shut down the stand, move the card to a **Raspberry Pi Zero 2 W** and connect the instrument to USB OTG. Have the instrument write a result file and confirm that the results appear in the LIMS.

Indicator states:

| Indicator | Meaning |
| --- | --- |
| Off | The device is powered off or the upload service has not started. |
| Purple | The service is starting and the application is initializing. |
| Blue | Upload initialization or connection to the LIMS server is in progress. |
| Green | The device is connected and in its upload state. Confirm delivery in the LIMS as well. |
| Red | There is a network problem or the LIMS server is unavailable. |

## Diagnostics

Replace `LIMS-USB` in the commands below with the device name entered during installation.

Check the application service:

```bash
sudo systemctl status pdb.LIMS-USB.service
```

Follow its messages:

```bash
sudo tail -f /root/.projectdb/log/pdb.LIMS-USB.log
```

View USB script messages:

```bash
sudo tail -n 100 /root/.projectdb/log/projectdb-usb.log
```

Open Raspberry Pi settings, including network configuration:

```bash
sudo raspi-config
```

Shut down before removing the memory card:

```bash
sudo poweroff
```

Manage the device through systemd. ProjectDB commands that change its launch mode or service configuration are blocked. `projectdb start LIMS-USB` starts the existing service. Update the platform with `sudo npm install projectdb@latest -g`. If the release library `app.so` is stored in `/opt/pdb/lib`, replace it separately while the service is stopped.

Do not share the connection file or recovery plan: they contain the device access password. When requesting help, provide the failed step and relevant log messages without credentials.

[Return to the ProjectDB guide](../README.md)
