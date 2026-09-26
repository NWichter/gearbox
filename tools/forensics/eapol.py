import pandas as pd
pd.set_option('display.width',300); pd.set_option('display.max_rows',3000)
e=pd.read_pickle('/work/ev2.pkl')
k=e[e['eapol.type']=='3']
for d,c,ki,rc in zip(k.d,k.cli,k['wlan_rsna_eapol.keydes.key_info'],k['eapol.keydes.replay_counter']): print(c,d,ki,rc)
q=e[(e.st==40)&(e['eapol.type'].isna())]
print('QoS non-eapol', len(q)); print(q.groupby(['sensor','cli']).size().head(50))
print(q.d.head(20).to_string())
