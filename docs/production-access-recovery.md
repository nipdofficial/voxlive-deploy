# VoxLive production access recovery

Status: administrator action required. No production access or network changes have been made.

## Verified production instance

- Account: `486872284508`
- Region: `eu-north-1`
- Instance: `i-081b3c296a89578f8`
- Operating system: Amazon Linux 2023, from custom AMI `ami-0b979de597ab43249`
- Public/private addresses: `56.228.15.255` / `172.31.24.24`
- CloudFront origin: `ec2-56-228-15-255.eu-north-1.compute.amazonaws.com`
- IAM instance profile: none
- EC2 key pair: none
- Systems Manager registration: absent
- Security group: `sg-01432de9fe7aa0156`, public TCP 80 only; no IPv6 ingress
- Root volume: unencrypted 8 GB gp3, delete on termination
- Data volume: encrypted 20 GB gp3, retained on termination

The current instance has no authenticated management path. The account-level EC2 Serial Console is enabled, but AWS Linux AMIs do not normally have a password-based OS user, which is required for an interactive Linux serial-console login. The security group has no SSH rule and the instance has no EC2 key pair.

## Required administrator action

Create a dedicated IAM role named `VoxLiveEC2SSMRole`:

1. IAM → Roles → Create role.
2. Trusted entity: AWS service → EC2.
3. Attach only `AmazonSSMManagedInstanceCore`.
4. Create the role and its instance profile. Do not add S3, Lambda or application administrator policies.
5. EC2 → Instances → `i-081b3c296a89578f8` → Actions → Security → Modify IAM role.
6. Select `VoxLiveEC2SSMRole` and update the role.

Attaching an instance profile to a running EC2 instance does not require a stop or reboot. Amazon Linux 2023 normally includes SSM Agent. The instance already has outbound internet access, so it should register after the profile credentials become available if the agent is installed and running.

Do not attach the existing `pcfr-fraud-ssm-role`: it belongs to another system and also grants full S3 and Lambda access.

## Verification after attachment

```powershell
aws ssm describe-instance-information --region eu-north-1 --filters Key=InstanceIds,Values=i-081b3c296a89578f8 --query "InstanceInformationList[0].{InstanceId:InstanceId,PingStatus:PingStatus,Platform:PlatformName,AgentVersion:AgentVersion}" --output table

aws ssm start-session --region eu-north-1 --target i-081b3c296a89578f8
```

If the instance does not register after several minutes, an administrator must use an approved recovery path to start or reinstall SSM Agent. EC2 Serial Console will not provide an interactive shell without an existing password-based OS user. EC2 Instance Connect would require confirmed package support and a narrowly scoped temporary SSH rule. Offline EBS recovery requires downtime and a recovery instance, so it must not be attempted without separate approval.

## Permissions for the deployment operator

If the administrator attaches the role but expects IAM user `danidu` to open the session, that user must retain the required Session Manager start/terminate/resume permissions for this instance. If the operator must attach the role, grant `ec2:AssociateIamInstanceProfile` for this instance and `iam:PassRole` only for `VoxLiveEC2SSMRole` with the passed-to-service condition restricted to `ec2.amazonaws.com`.

References:

- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/attach-iam-role.html
- https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-instance-permissions.html
- https://docs.aws.amazon.com/en_en/systems-manager/latest/userguide/agent-install-al2.html
- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configure-access-to-serial-console.html
