import re, collections
for i in range(1,9):
    data=open(f'/data/sensor0{i}.pcap','rb').read()
    c=collections.Counter(m.group() for m in re.finditer(rb'[\x20-\x7e]{5,}',data))
    print(i, [(k.decode(),v) for k,v in c.most_common(40) if v<100000][:40])
    # pcap header
    print(data[:24].hex())
