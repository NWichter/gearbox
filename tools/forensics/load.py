import pandas as pd
dfs=[]
for i in range(1,9):
    d=pd.read_csv(f'/work/s0{i}.tsv',sep='\t',dtype=str,quoting=3)
    d['sensor']=i
    dfs.append(d)
df=pd.concat(dfs,ignore_index=True)
df['t']=df['frame.time_epoch'].astype(float)
t0=df.t.min(); df['rel']=df.t-t0
df['st']=df['wlan.fc.type_subtype'].apply(lambda x:int(x,16) if isinstance(x,str) and x.startswith('0x') else (int(x) if isinstance(x,str) else -1))
def dec(h):
    if not isinstance(h,str): return None
    try: return bytes.fromhex(h.split(',')[0]).decode('utf-8','replace')
    except Exception: return h
df['ssid_txt']=df['wlan.ssid'].apply(dec)
df.to_pickle('/work/all.pkl')
print(t0, pd.to_datetime(t0,unit='s'), df.rel.max())
print(df.groupby(['sensor','st']).size().unstack(fill_value=0).T)
