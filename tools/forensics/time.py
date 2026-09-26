import pandas as pd, numpy as np
pd.set_option('display.width',300); pd.set_option('display.max_rows',3000); pd.set_option('display.max_columns',60)
e=pd.read_pickle('/work/ev2.pkl')
e['bin']=(e.rel//60).astype(int)
e['kind']=e.st.map({0:'AsReq',1:'AsResp',10:'Disas',11:'Auth',12:'Deauth',13:'Act',40:'QoS',32:'Data',44:'QNull'})+e['wlan.fixed.reason_code'].fillna('').str.replace('0x00','/')
e.loc[e['eap.code']=='1','kind']='EAPreqId'
e.loc[e['eap.code']=='2','kind']='EAPrespId'
print(e.groupby(['bin','kind']).size().unstack(fill_value=0).to_string())
