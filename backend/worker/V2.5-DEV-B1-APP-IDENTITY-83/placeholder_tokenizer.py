"""Offline SQL placeholder lexical checker. Not a SQL parser and never executes SQL."""
from dataclasses import dataclass

class TokenizerError(ValueError):
    pass

@dataclass(frozen=True)
class Placeholder:
    ordinal: int
    offset: int

def placeholders(sql: str) -> list[Placeholder]:
    if not isinstance(sql, str) or not sql:
        raise TokenizerError("SQL must be a non-empty string")
    out=[]
    i=0
    n=len(sql)
    while i<n:
        c=sql[i]
        if c=="'":
            i+=1
            while i<n:
                if sql[i]=="'":
                    if i+1<n and sql[i+1]=="'":
                        i+=2
                        continue
                    i+=1
                    break
                i+=1
            else:
                raise TokenizerError("unterminated single-quoted string")
            continue
        if c=='"':
            i+=1
            while i<n:
                if sql[i]=='"':
                    if i+1<n and sql[i+1]=='"':
                        i+=2
                        continue
                    i+=1
                    break
                i+=1
            else:
                raise TokenizerError("unterminated double-quoted identifier/string")
            continue
        if c=='`':
            i+=1
            while i<n:
                if sql[i]=='`':
                    if i+1<n and sql[i+1]=='`':
                        i+=2
                        continue
                    i+=1
                    break
                i+=1
            else:
                raise TokenizerError("unterminated backtick identifier")
            continue
        if c=='[':
            i+=1
            while i<n:
                if sql[i]==']':
                    if i+1<n and sql[i+1]==']':
                        i+=2
                        continue
                    i+=1
                    break
                i+=1
            else:
                raise TokenizerError("unterminated bracket identifier")
            continue
        if c=='-' and i+1<n and sql[i+1]=='-':
            i+=2
            while i<n and sql[i] not in '\r\n':
                i+=1
            continue
        if c=='/' and i+1<n and sql[i+1]=='*':
            end=sql.find('*/',i+2)
            if end<0:
                raise TokenizerError("unterminated block comment")
            i=end+2
            continue
        if c=='?':
            start=i
            i+=1
            if i<n and sql[i].isdigit():
                while i<n and sql[i].isdigit():
                    i+=1
                raise TokenizerError("numbered placeholder ?NNN is forbidden")
            out.append(Placeholder(len(out)+1,start))
            continue
        if c in (':','@','
        i+=1
    return out

def validate_bind_count(sql: str, bind_count: int) -> list[Placeholder]:
    found=placeholders(sql)
    if bind_count != len(found):
        raise TokenizerError(f"placeholder/bind count mismatch: {len(found)} != {bind_count}")
    return found
):
            raise TokenizerError("named or ambiguous parameter marker is forbidden")
        i+=1
    return out

def validate_bind_count(sql: str, bind_count: int) -> list[Placeholder]:
    found=placeholders(sql)
    if bind_count != len(found):
        raise TokenizerError(f"placeholder/bind count mismatch: {len(found)} != {bind_count}")
    return found
