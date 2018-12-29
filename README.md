HyperVault
==========

WORK IN PROGRESS!

| Feature               |      Status |
|-----------------------|------------:|
| Distributed clock     | in progress |
| Selective replication |        done |
| Swarm/replication     |        todo |
| Storage Encryption    |        todo |
| FUSE support          |        todo |


Notes on concurrent modifications:

The tree must support the following operations:

| op                | note                                   |
|-------------------+----------------------------------------|
| set data for path | allocated logspace = olddata + newdata |
| set stat for path | update file descriptor                 |
| delete path       | mark file as deleted                   |
| rename path       | update path of file                    |




`path` means path to file, i'm not planning on supporting folders;
do delete a folder or rename a folder a client must recursively generate
operations to delete/rename all files that match that path.

