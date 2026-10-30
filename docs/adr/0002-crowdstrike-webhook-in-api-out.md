# CrowdStrike Alerts arrive by Fusion webhook, changes go back by API

Inbound, each Organization configures a Falcon Fusion workflow that pushes Alerts to a per-Integration webhook URL authenticated with a shared secret header; Argus upserts by CrowdStrike's alert ID, so re-sent or updated alerts never duplicate. We chose push over polling the Falcon Alerts API to avoid running a per-Organization poller and to get Alerts in near real time. Outbound, sync is two-way: Argus writes changes back to Falcon through the Falcon API, so an Integration also holds Falcon API credentials.
