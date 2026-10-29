# VoxLive: proposed AWS private-origin rollout

Status: **proposal only**. No network or production changes have been made.

## Current verified configuration

- Account region: `eu-north-1`; distribution `E2MHFQGBYT0KC6`; frontend S3 origin and EC2 API origin.
- Backend EC2 instance `i-081b3c296a89578f8` uses subnet `subnet-049bd195f58ac904c` in `eu-north-1a` and persistent data volume `vol-0e53b658b1cbc1dac`.
- All three current subnets have public IPv4 allocation enabled and the VPC's route table has a default route to an internet gateway. No available NAT gateway or existing CloudFront VPC Origin was found.
- The EC2 instance has no instance profile, configured SSH key, or Systems Manager managed connection. CloudFront's VPC Origin service-linked role was not found. IAM policy simulation was denied, so actual permission to create it or pass an EC2 role is unverified.
- CloudFront currently connects to the custom origin using HTTP; port 80 is open to the public, and anonymous history is accessible.

## Architecture comparison (730 hours per month)

These are estimates, not a guaranteed bill. Pricing, free-tier eligibility, taxes, traffic, backups, burst credits and staging resources must be checked in the account before provisioning.

| Option | Estimated additional fixed monthly cost | Assessment |
| --- | --- | --- |
| VPC Origin, private IPv4 and IPv6-only egress | Approximately $0 for an egress-only internet gateway; other resources and traffic extra | Gemini DNS returned IPv6 addresses, but the configured LiveKit signaling host and GitHub returned only IPv4 in a local DNS check. IPv6-only egress is therefore not verified for this application. DNS results can vary; test from AWS. VPC Origin itself requires private IPv4. |
| VPC Origin with a self-managed NAT instance | Approximately $8.26 gross: t3.nano $3.94, public IPv4 $3.65, 8 GB gp3 $0.67. If the existing backend public IPv4 is released, the illustrative net increase is approximately $4.61. | IPv4 egress supports existing dependencies, subject to LiveKit media testing. NAT requires maintenance, source/destination checking disabled, monitoring and a failure recovery plan. It is a single point of failure. Data transfer and other charges are extra. |
| Existing public EC2 with restricted ingress | Approximately $0 incremental fixed cost if existing resources are reused | CloudFront origin-facing IP restrictions alone do not identify this distribution; add a secret origin header and enforce it on HTTP and WebSocket requests. Origin traffic would still be unencrypted HTTP, so credentials and transcript data remain exposed on that connection. This is not equivalent to end-to-end HTTPS. |

The illustrative Stockholm NAT instance rates are $0.0054/hour, $0.005/hour for public IPv4 and $0.0836/GB-month for gp3. Confirm actual rates and available CloudFront plan features before approval. A NAT gateway has intentionally not been proposed or created.

CloudFront VPC Origin supports WebSockets and needs a private IPv4 address. An internet gateway must be attached to the VPC. IPv6 egress-only internet gateways do not provide IPv4 connectivity: IPv4-only services would require a separate translation or NAT solution. Local DNS observation is not proof of actual IPv6 reachability or that LiveKit's dynamic media endpoints work.

Without a custom domain and publicly trusted matching origin certificate, the proposed private VPC origin would use HTTP on the private path. Private connectivity is not application-layer TLS. **No private HTTP has been approved.**

## Conditional private-origin rollout

1. Back up the current EBS data volume; validate the snapshot before migration.
2. Create a private subnet in the existing VPC in `eu-north-1a`, with a dedicated route table and outbound NAT connectivity for Gemini and LiveKit. Do not change the existing public subnet's shared routing table.
3. Provide a secure, authorized management path for the replacement private EC2 instance. A narrowly scoped Systems Manager instance profile and permitted `iam:PassRole` are preferred; an EC2 Instance Connect Endpoint with appropriate access and SSH setup is an alternative. Neither has been configured or confirmed authorized.
4. Create a replacement EC2 instance in the private subnet and attach the current data volume only during a controlled cutover. Retain the original instance and the fresh backup for recovery.
5. Create a CloudFront VPC Origin and a staging distribution using the private EC2 instance. Restrict the origin security group to the CloudFront-managed VPC-origin security group. Validate authenticated REST and WebSocket paths, LiveKit, Gemini outbound access, QR invitations and protected history.
6. Coordinate backend/frontend deployment, promote the staging origin, and close direct public origin access only after validation. If a security regression occurs, keep the affected APIs unavailable rather than restoring unauthenticated public history.

## Explicit approvals and open issues

- Without a domain and publicly trusted matching certificate, the direct EC2 origin would use **HTTP across the private VPC-origin path**. Private networking limits network exposure but does not itself establish application-layer TLS. The user explicitly requires approval before using private HTTP; that approval has not been given.
- A NAT instance, replacement EC2 instance, staging infrastructure and snapshots can incur charges. Confirm a spending limit and actual region-specific pricing before creating billable resources.
- Administrative setup for the CloudFront VPC Origin service-linked role and the EC2 management role may require IAM permissions not yet confirmed. The current EC2 instance has no SSM management profile.
- User-provided Sinhala/mixed-language test recordings and a second-device QR test are not currently available. Real LiveKit staging produced a translation in one run but another run timed out; the live reliability release gate remains unmet.
- New invitations use a random secret. Organizers must regenerate previously shared QR codes and links; ownerless legacy history remains admin-only.

References: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html ; https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-service-linked-roles.html ; https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-https-cloudfront-to-custom-origin.html ; https://aws.amazon.com/vpc/pricing/

Additional references: https://docs.aws.amazon.com/vpc/latest/userguide/egress-only-internet-gateway.html ; https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-nat64-dns64.html ; https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html ; https://aws.amazon.com/about-aws/whats-new/2026/05/amazon-cloudfront-websockets-vpc-origins/
