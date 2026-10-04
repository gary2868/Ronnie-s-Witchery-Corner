Ronnie's Witchery Corner
19 欄白名單測試版

本版目的：
- reservations 嚴格只寫入目前 Supabase 的 19 欄。
- customers 嚴格只寫入目前 Supabase 的 8 欄。
- closures 嚴格只寫入目前 Supabase 的 5 欄。
- 不修改 Supabase Schema。
- 不寫入 my_note / status_label / other_status / tags 等不存在的頂層資料庫欄位。
- 客戶 tags 保留在 history JSON 中，不增加資料表欄位。
- public 表單不要求 Line ID；line_id 以空字串寫入以符合 NOT NULL。

reservations 19 欄：
id
booking_code
name
birth_date
phone
line_id
note
service_id
service_name
duration_minutes
date
start_time
end_time
service_slots
slots
status
created_at
updated_at
cancelled_at

customers 8 欄：
id
name
birth_date
phone
line_id
created_at
updated_at
history

closures 5 欄：
id
date
start_time
end_time
created_at

驗收：
node --check server_19cols_whitelist_final.js 已通過。
