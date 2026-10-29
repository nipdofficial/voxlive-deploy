# VoxLive no-role deployment recovery

Status: proposal prepared from read-only AWS checks. No production change has been made.

## Findings

- Production instance: `i-081b3c296a89578f8`, Amazon Linux 2023, public address `56.228.15.255`.
- The instance was launched manually by IAM user `danidu`. Launch user data cloned the GitHub repository into `/opt/voxlive`, built the backend container and mounted persistent data at `/mnt/voxlive-data`.
- No GitHub Actions workflow, CodeDeploy application, ECS cluster or Elastic Beanstalk environment exists for VoxLive.
- The current IAM user cannot list CodePipeline or CodeBuild, so an administrator must confirm that those services do not contain an unrelated pipeline before any Git push.
- Systems Manager Default Host Management Configuration is disabled. The production instance is not registered with SSM.
- The CloudFront distribution has no WAF web ACL, edge function, Lambda association, continuous-deployment policy or origin verification header.
- Four account WAF ACLs exist, but every one is attached to another CloudFront distribution. They must not be modified or reused for VoxLive.
- Port 80 on the origin is directly public. A CloudFront-only history block does not contain direct-origin disclosure.
- Production launch user data contains embedded credentials. Rotate the Google service-account key, LiveKit key/secret and application administrator password. Do not reuse or print those values.

## Simplest recovery without an EC2 instance role

Use EC2 Instance Connect with its ephemeral 60-second SSH key.

Prerequisites:

1. Grant IAM user `danidu` `ec2-instance-connect:SendSSHPublicKey` only for `arn:aws:ec2:eu-north-1:486872284508:instance/i-081b3c296a89578f8`, conditioned on `ec2:osuser` equal to `ec2-user`.
2. Preserve existing `ec2:DescribeInstances` access.
3. Temporarily add TCP 22 ingress to `sg-01432de9fe7aa0156` from AWS-managed prefix list `pl-0bd77a95ba8e317a6` (`com.amazonaws.eu-north-1.ec2-instance-connect`).
4. Connect through EC2 → Instances → production instance → Connect → EC2 Instance Connect, username `ec2-user`.
5. After deployment verification, remove the temporary TCP 22 rule.

Amazon Linux 2023 standard AMIs include EC2 Instance Connect. This production AMI is a custom derivative, so successful connection is the only conclusive package/configuration check. The method adds no EC2 instance profile and no hourly AWS resource.

If Instance Connect fails because the package or SSH daemon configuration is absent, do not broaden SSH access. The next supported recovery is administrator-assisted offline root-volume recovery, which requires an approved maintenance window, a snapshot and a recovery instance.

## Temporary transcript containment

Confirmed sensitive route families include:

- `/api/history` and every child route, including record details, audio, translation, summary, mutation and WebSocket events.
- `/api/meetings/mine/history`.
- `/api/meetings/*/transcript`.

A CloudFront/WAF block alone is incomplete while direct EC2 port 80 is public. Complete zero-cost emergency containment would require revoking the origin's port 80 ingress, which makes the entire API unavailable. The preferred response is to recover Instance Connect access and deploy the tested backend authorization immediately.

## Deployment order after approval

1. Establish Instance Connect and inspect the running container, mounted data and available disk space.
2. Rotate the exposed provider and administrator credentials.
3. Back up application configuration and persistent data without printing secrets.
4. Deploy the tested authorization-compatible backend and frontend.
5. Add the CloudFront origin verification header, store its value only on the server and enable backend enforcement in a coordinated update.
6. Restrict TCP 80 to the CloudFront origin-facing prefix list `pl-fab65393`.
7. Test REST and WebSocket paths through CloudFront, then confirm direct origin requests fail.
8. Remove temporary TCP 22 access.
9. Verify anonymous history denial, ownership, downloads, attendee access, persistence and live translation on production.

The CloudFront-to-EC2 connection remains HTTP and is not end-to-end encrypted.

## Cost

- EC2 Instance Connect ephemeral key: no additional fixed charge.
- Temporary security-group rule: no charge.
- Existing CloudFront/EC2/S3 reuse: no new fixed resource.
- EBS snapshots, a recovery instance or a new WAF web ACL are excluded until separately approved because they can incur charges.

References:

- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-connect-methods.html
- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-connect-configure-IAM-role.html
- https://docs.aws.amazon.com/us_en/AWSEC2/latest/UserGuide/ec2-instance-connect-set-up.html
